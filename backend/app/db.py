"""SQLite persistence for workflow executions and per-stage execution details.

Two levels of data are stored:

* ``executions``        — one row per workflow run (the "每次执行" header)
* ``task_executions``   — one row per stage (环节) within a run, carrying the
                          row count (条数) and measured duration (处理耗时)
* ``stages``            — the stage dimension table; it is the single source of
                          truth used for LEFT JOIN aggregation so that stages
                          without any data in a time range still appear as 0.

Every helper opens a short-lived connection so the module is safe to call from
the simulated worker threads as well as from FastAPI request handlers.
"""

import random
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "executions.db"

# Stage dimension — single source of truth shared by the live DAG simulation,
# the report queries and the seeded demo data.
# base_duration_ms: simulated average processing duration
# base_rows: simulated average row count produced/handled per run
STAGES: List[Dict[str, Any]] = [
    {"id": "extract",       "name": "数据提取",   "stage_order": 0,  "base_duration_ms": 2000, "base_rows": 12000},
    {"id": "validate",      "name": "数据校验",   "stage_order": 1,  "base_duration_ms": 1500, "base_rows": 11800},
    {"id": "clean_a",       "name": "清洗分支A",  "stage_order": 2,  "base_duration_ms": 1800, "base_rows": 11500},
    {"id": "clean_b",       "name": "清洗分支B",  "stage_order": 3,  "base_duration_ms": 1200, "base_rows": 11200},
    {"id": "transform",     "name": "数据转换",   "stage_order": 4,  "base_duration_ms": 3000, "base_rows": 10800},
    {"id": "enrich",        "name": "数据增强",   "stage_order": 5,  "base_duration_ms": 2000, "base_rows": 15000},
    {"id": "aggregate",     "name": "聚合计算",   "stage_order": 6,  "base_duration_ms": 2500, "base_rows": 900},
    {"id": "quality",       "name": "质量检查",   "stage_order": 7,  "base_duration_ms": 1000, "base_rows": 880},
    {"id": "export_db",     "name": "入库",       "stage_order": 8,  "base_duration_ms": 1800, "base_rows": 850},
    {"id": "export_report", "name": "报表生成",   "stage_order": 9,  "base_duration_ms": 2200, "base_rows": 60},
    {"id": "notify",        "name": "通知",       "stage_order": 10, "base_duration_ms": 500,  "base_rows": 12},
]

STAGE_MAP = {s["id"]: s for s in STAGES}

_write_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS stages (
                id               TEXT PRIMARY KEY,
                name             TEXT NOT NULL,
                stage_order      INTEGER NOT NULL,
                base_duration_ms REAL NOT NULL,
                base_rows        INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS executions (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                workflow_id   INTEGER NOT NULL,
                workflow_name TEXT NOT NULL,
                status        TEXT NOT NULL,              -- RUNNING / SUCCESS / FAILED
                start_time    REAL NOT NULL,              -- epoch seconds
                end_time      REAL
            );
            CREATE INDEX IF NOT EXISTS idx_exec_start ON executions(start_time);
            CREATE INDEX IF NOT EXISTS idx_exec_status ON executions(status);

            CREATE TABLE IF NOT EXISTS task_executions (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
                task_id      TEXT NOT NULL,
                task_name    TEXT NOT NULL,
                stage_order  INTEGER NOT NULL,
                status       TEXT NOT NULL,               -- SUCCESS / FAILED
                row_count    INTEGER NOT NULL,
                duration_ms  REAL NOT NULL,
                retries      INTEGER NOT NULL DEFAULT 0,
                start_time   REAL NOT NULL,
                end_time     REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_te_exec  ON task_executions(execution_id);
            CREATE INDEX IF NOT EXISTS idx_te_stage ON task_executions(task_id);
            CREATE INDEX IF NOT EXISTS idx_te_end   ON task_executions(end_time);
            """
        )
        conn.executemany(
            "INSERT OR IGNORE INTO stages (id, name, stage_order, base_duration_ms, base_rows)"
            " VALUES (:id, :name, :stage_order, :base_duration_ms, :base_rows)",
            STAGES,
        )


# --------------------------------------------------------------------------- #
# Write helpers (used by the live execution engine)
# --------------------------------------------------------------------------- #

def create_execution(workflow_id: int, workflow_name: str, start_time: Optional[float] = None) -> int:
    with _write_lock, _connect() as conn:
        cur = conn.execute(
            "INSERT INTO executions (workflow_id, workflow_name, status, start_time)"
            " VALUES (?, ?, 'RUNNING', ?)",
            (workflow_id, workflow_name, start_time or time.time()),
        )
        return int(cur.lastrowid)


def record_task_execution(
    execution_id: int,
    task_id: str,
    status: str,
    row_count: int,
    duration_ms: float,
    retries: int = 0,
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
) -> None:
    end_time = end_time or time.time()
    start_time = start_time if start_time is not None else end_time - duration_ms / 1000.0
    stage = STAGE_MAP.get(task_id, {"name": task_id, "stage_order": 0})
    with _write_lock, _connect() as conn:
        conn.execute(
            "INSERT INTO task_executions"
            " (execution_id, task_id, task_name, stage_order, status, row_count, duration_ms, retries, start_time, end_time)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                execution_id, task_id, stage["name"], stage.get("stage_order", 0),
                status, int(row_count), float(duration_ms), int(retries), start_time, end_time,
            ),
        )


def finish_execution(execution_id: int, status: str, end_time: Optional[float] = None) -> None:
    with _write_lock, _connect() as conn:
        conn.execute(
            "UPDATE executions SET status = ?, end_time = ? WHERE id = ?",
            (status, end_time or time.time(), execution_id),
        )


def simulate_row_count(task_id: str, run_factor: float) -> int:
    """Simulated 条数 for one stage of a live run.

    ``run_factor`` (~0.85-1.15) is shared by all stages of one run so the row
    counts within a run move together, like real data volume would.
    """
    base = STAGE_MAP.get(task_id, {}).get("base_rows", 1000)
    return max(0, int(base * run_factor * random.uniform(0.92, 1.08)))


# --------------------------------------------------------------------------- #
# Shared filter — summary / detail / trend MUST all use this WHERE clause so
# the aggregated report and the row-level details are always reconcilable.
# --------------------------------------------------------------------------- #

def _exec_filter_clause(prefix: str = "") -> str:
    p = f"{prefix}." if prefix else ""
    return (
        f"({p}start_time >= :start OR :start IS NULL) AND "
        f"({p}start_time <= :end   OR :end   IS NULL) AND "
        f"({p}status = :status     OR :status IS NULL)"
    )


def _filter_params(start_time: Optional[float], end_time: Optional[float], status: Optional[str]) -> Dict[str, Any]:
    return {"start": start_time, "end": end_time, "status": status}


def list_stages() -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, stage_order AS stageOrder, base_duration_ms AS baseDurationMs,"
            " base_rows AS baseRows FROM stages ORDER BY stage_order"
        ).fetchall()
        return [dict(r) for r in rows]


# Columns the report is allowed to sort by (guard against arbitrary SQL).
SORT_COLUMNS = {
    "stageOrder": "stageOrder",
    "taskName": "taskName",
    "execCount": "execCount",
    "totalRows": "totalRows",
    "totalDurationMs": "totalDurationMs",
    "avgRows": "avgRows",
    "avgDurationMs": "avgDurationMs",
    "pctDuration": "pctDuration",
}


def get_summary(
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
    status: Optional[str] = None,
    page: int = 1,
    page_size: int = 10,
    sort_by: str = "stageOrder",
    sort_order: str = "asc",
) -> Dict[str, Any]:
    """Per-stage aggregation. Stages without data are filled in as 0 via a
    LEFT JOIN against the stage dimension table."""
    params = _filter_params(start_time, end_time, status)

    with _connect() as conn:
        # Grand totals across ALL stage rows in range — denominator for 占比,
        # and also the exact same numbers the detail endpoint totals return.
        overall = conn.execute(
            f"""
            SELECT COUNT(te.id) AS stageRowCount,
                   COALESCE(SUM(te.row_count), 0)   AS totalRows,
                   COALESCE(SUM(te.duration_ms), 0) AS totalDurationMs
            FROM task_executions te
            WHERE te.execution_id IN (
                SELECT id FROM executions e WHERE {_exec_filter_clause('e')}
            )
            """,
            params,
        ).fetchone()
        execution_count = conn.execute(
            f"SELECT COUNT(*) AS c FROM executions e WHERE {_exec_filter_clause('e')}",
            params,
        ).fetchone()["c"]

        rows = conn.execute(
            f"""
            SELECT s.id AS taskId, s.name AS taskName, s.stage_order AS stageOrder,
                   COUNT(te.id)                      AS execCount,
                   COALESCE(SUM(te.row_count), 0)    AS totalRows,
                   COALESCE(SUM(te.duration_ms), 0)  AS totalDurationMs,
                   COALESCE(AVG(te.row_count), 0)    AS avgRows,
                   COALESCE(AVG(te.duration_ms), 0)  AS avgDurationMs
            FROM stages s
            LEFT JOIN task_executions te
                   ON te.task_id = s.id
                  AND te.execution_id IN (
                        SELECT id FROM executions e WHERE {_exec_filter_clause('e')}
                  )
            GROUP BY s.id
            """,
            params,
        ).fetchall()

    grand_duration = float(overall["totalDurationMs"])
    items: List[Dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        d["pctDuration"] = (d["totalDurationMs"] / grand_duration) if grand_duration > 0 else 0.0
        items.append(d)

    reverse = sort_order.lower() == "desc"
    sort_col = SORT_COLUMNS.get(sort_by, "stageOrder")
    items.sort(key=lambda x: (x[sort_col] is None, x[sort_col]), reverse=reverse)

    total = len(items)
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    start_idx = (page - 1) * page_size

    return {
        "page": page,
        "pageSize": page_size,
        "total": total,
        "overall": {
            "executionCount": execution_count,
            "stageRowCount": overall["stageRowCount"],
            "totalRows": overall["totalRows"],
            "totalDurationMs": grand_duration,
        },
        "items": items[start_idx:start_idx + page_size],
    }


def get_details(
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
    status: Optional[str] = None,
    task_id: Optional[str] = None,
    page: int = 1,
    page_size: int = 10,
) -> Dict[str, Any]:
    """Row-level per-stage execution details for point-by-point reconciliation."""
    params = _filter_params(start_time, end_time, status)
    params["task_id"] = task_id

    where = [f"te.execution_id IN (SELECT id FROM executions e WHERE {_exec_filter_clause('e')})"]
    if task_id:
        where.append("te.task_id = :task_id")
    where_sql = " AND ".join(where)

    with _connect() as conn:
        totals = conn.execute(
            f"""
            SELECT COUNT(te.id) AS stageRowCount,
                   COALESCE(SUM(te.row_count), 0)   AS totalRows,
                   COALESCE(SUM(te.duration_ms), 0) AS totalDurationMs
            FROM task_executions te WHERE {where_sql}
            """,
            params,
        ).fetchone()
        total = conn.execute(
            f"SELECT COUNT(*) AS c FROM task_executions te WHERE {where_sql}", params
        ).fetchone()["c"]

        page = max(1, page)
        page_size = max(1, min(page_size, 200))
        params["limit"] = page_size
        params["offset"] = (page - 1) * page_size

        rows = conn.execute(
            f"""
            SELECT te.id, te.execution_id AS executionId, e.workflow_name AS workflowName,
                   e.status AS executionStatus, e.start_time AS executionStartTime,
                   e.end_time AS executionEndTime,
                   te.task_id AS taskId, te.task_name AS taskName, te.stage_order AS stageOrder,
                   te.status, te.row_count AS rowCount, te.duration_ms AS durationMs,
                   te.retries, te.start_time AS startTime, te.end_time AS endTime
            FROM task_executions te
            JOIN executions e ON e.id = te.execution_id
            WHERE {where_sql}
            ORDER BY e.start_time DESC, te.stage_order ASC, te.id ASC
            LIMIT :limit OFFSET :offset
            """,
            params,
        ).fetchall()

    return {
        "page": page,
        "pageSize": page_size,
        "total": total,
        "totals": {
            "stageRowCount": totals["stageRowCount"],
            "totalRows": totals["totalRows"],
            "totalDurationMs": float(totals["totalDurationMs"]),
        },
        "items": [dict(r) for r in rows],
    }


def get_trend(
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
    status: Optional[str] = None,
    task_ids: Optional[List[str]] = None,
    limit: int = 10,
) -> Dict[str, Any]:
    """Duration trend of the most recent N runs within the filter range.

    Returns one slot per execution per requested stage; slots are ``None`` when
    a stage has no row for that execution (e.g. failed-before-reaching-it), so
    the chart shows genuine gaps instead of dropping the whole execution.
    """
    limit = max(1, min(int(limit), 50))
    valid_ids = {s["id"] for s in STAGES}
    selected = [t for t in (task_ids or []) if t in valid_ids]
    if not selected:
        selected = [s["id"] for s in STAGES[:4]]

    params = _filter_params(start_time, end_time, status)
    params["limit"] = limit

    with _connect() as conn:
        exec_rows = conn.execute(
            f"""
            SELECT id, workflow_name AS workflowName, status,
                   start_time AS startTime, end_time AS endTime
            FROM executions e
            WHERE {_exec_filter_clause('e')}
            ORDER BY start_time DESC, id DESC
            LIMIT :limit
            """,
            params,
        ).fetchall()
        executions = [dict(r) for r in reversed(exec_rows)]  # chronological order

        placeholders = ",".join(f":tid{i}" for i in range(len(selected)))
        for i, t in enumerate(selected):
            params[f"tid{i}"] = t
        ids = [e["id"] for e in executions]
        if ids:
            id_list = ",".join(f":eid{i}" for i in range(len(ids)))
            for i, eid in enumerate(ids):
                params[f"eid{i}"] = eid
            data_rows = conn.execute(
                f"""
                SELECT execution_id AS executionId, task_id AS taskId, status,
                       row_count AS rowCount, duration_ms AS durationMs
                FROM task_executions
                WHERE execution_id IN ({id_list}) AND task_id IN ({placeholders})
                """,
                params,
            ).fetchall()
        else:
            data_rows = []

    by_exec: Dict[int, Dict[str, Dict[str, Any]]] = {}
    for r in data_rows:
        by_exec.setdefault(r["executionId"], {})[r["taskId"]] = {
            "status": r["status"],
            "rowCount": r["rowCount"],
            "durationMs": float(r["durationMs"]),
        }

    series: Dict[str, List[Optional[Dict[str, Any]]]] = {t: [] for t in selected}
    for e in executions:
        slots = by_exec.get(e["id"], {})
        for t in selected:
            series[t].append(slots.get(t))  # None -> chart gap

    return {"limit": limit, "stages": selected, "executions": executions, "series": series}


# --------------------------------------------------------------------------- #
# Demo data seeding
# --------------------------------------------------------------------------- #

def seed_demo_data(runs: int = 50, days: int = 21, reset: bool = True) -> Dict[str, int]:
    """Generate simulated historical runs. A share of runs fail at a random
    stage, which naturally leaves later stages without rows (0-fill case)."""
    runs = max(1, min(int(runs), 500))
    days = max(1, min(int(days), 365))
    now = time.time()

    with _write_lock, _connect() as conn:
        if reset:
            conn.execute("DELETE FROM task_executions")
            conn.execute("DELETE FROM executions")
            conn.execute("DELETE FROM sqlite_sequence WHERE name IN ('executions','task_executions')")

        created = failed = 0
        for i in range(runs):
            run_factor = random.uniform(0.82, 1.18)
            is_fail = random.random() < 0.14
            fail_at = random.randint(1, len(STAGES) - 1) if is_fail else len(STAGES)

            start = now - random.random() * days * 86400
            cur = conn.execute(
                "INSERT INTO executions (workflow_id, workflow_name, status, start_time)"
                " VALUES (?, ?, 'RUNNING', ?)",
                (1, "data-pipeline", start),
            )
            exec_id = int(cur.lastrowid)

            t_cursor = start
            last_end = start
            for idx, stage in enumerate(STAGES[:fail_at]):
                duration_ms = stage["base_duration_ms"] * run_factor * random.uniform(0.7, 1.3)
                rows = max(0, int(stage["base_rows"] * run_factor * random.uniform(0.9, 1.1)))
                failing = is_fail and idx == fail_at - 1
                if failing:
                    duration_ms *= random.uniform(1.1, 1.6)
                    rows = int(rows * random.uniform(0.1, 0.5))
                t_cursor += duration_ms / 1000.0 * random.uniform(0.45, 0.7)
                last_end = t_cursor
                conn.execute(
                    "INSERT INTO task_executions"
                    " (execution_id, task_id, task_name, stage_order, status, row_count, duration_ms, retries, start_time, end_time)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        exec_id, stage["id"], stage["name"], stage["stage_order"],
                        "FAILED" if failing else "SUCCESS", rows, duration_ms,
                        random.randint(0, 3) if failing else random.randint(0, 1),
                        t_cursor - duration_ms / 1000.0, t_cursor,
                    ),
                )

            conn.execute(
                "UPDATE executions SET status = ?, end_time = ? WHERE id = ?",
                ("FAILED" if is_fail else "SUCCESS", last_end, exec_id),
            )
            created += 1
            failed += 1 if is_fail else 0

    return {"created": created, "failed": failed}


def execution_count() -> int:
    with _connect() as conn:
        return int(conn.execute("SELECT COUNT(*) AS c FROM executions").fetchone()["c"])
