"""执行报表存储层。

所有执行以 execution(一次工作流执行) + execution_stage(每个环节在该次执行中的一条明细)
两张表落库；stage_def 维护环节字典，保证“没有数据的环节”在汇总中按 0 参与而不是整段丢掉。

时间统一用毫秒时间戳（int），与前端 startTime/endTime 口径一致。
"""
import os
import math
import random
import sqlite3
import threading
import time

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "reports.db")
_lock = threading.Lock()

# 环节字典：id / 名称 / 典型耗时(秒)，顺序即默认排序（DAG 拓扑顺序）
STAGE_DEFS = [
    ("extract", "数据提取", 2.0),
    ("validate", "数据校验", 1.5),
    ("clean_a", "清洗分支A", 1.8),
    ("clean_b", "清洗分支B", 1.2),
    ("transform", "数据转换", 3.0),
    ("enrich", "数据增强", 2.0),
    ("aggregate", "聚合计算", 2.5),
    ("quality", "质量检查", 1.0),
    ("export_db", "入库", 1.8),
    ("export_report", "报表生成", 2.2),
    ("notify", "通知", 0.5),
]
STAGE_IDS = [s[0] for s in STAGE_DEFS]


def _connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


_conn = _connect()


def init_db():
    with _lock:
        _conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS stage_def (
                stage_id   TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                seq        INTEGER NOT NULL,
                base_dur   REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS execution (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                workflow_id  INTEGER NOT NULL,
                started_at   INTEGER NOT NULL,
                ended_at     INTEGER,
                status       TEXT NOT NULL DEFAULT 'RUNNING',
                workers      INTEGER,
                strategy     TEXT
            );
            CREATE TABLE IF NOT EXISTS execution_stage (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id INTEGER NOT NULL,
                stage_id     TEXT NOT NULL,
                row_count    INTEGER NOT NULL,
                duration_ms  INTEGER NOT NULL,
                retries      INTEGER NOT NULL DEFAULT 0,
                status       TEXT NOT NULL DEFAULT 'SUCCESS',
                started_at   INTEGER NOT NULL,
                ended_at     INTEGER NOT NULL,
                FOREIGN KEY(execution_id) REFERENCES execution(id)
            );
            CREATE INDEX IF NOT EXISTS idx_stage_exec ON execution_stage(stage_id, execution_id);
            CREATE INDEX IF NOT EXISTS idx_exec_start ON execution(started_at);
            CREATE INDEX IF NOT EXISTS idx_stage_start ON execution_stage(started_at);
            """
        )
        _conn.executemany(
            "INSERT INTO stage_def(stage_id, name, seq, base_dur) VALUES(?,?,?,?) "
            "ON CONFLICT(stage_id) DO UPDATE SET name=excluded.name, seq=excluded.seq, base_dur=excluded.base_dur",
            [(sid, name, i, dur) for i, (sid, name, dur) in enumerate(STAGE_DEFS)],
        )
        _conn.commit()
        if _conn.execute("SELECT COUNT(*) FROM execution").fetchone()[0] == 0:
            _seed_locked()


# ----------------------------------------------------------------------------
# 历史数据种子：让报表开箱即可查看（最近 14 天 48 次执行）
# ----------------------------------------------------------------------------

def _lognorm(rng, mean, sigma=0.22):
    return mean * math.exp(rng.gauss(0, sigma))


def _seed_locked():
    """填充种子数据；调用方必须已持有 _lock（init_db 首次初始化时调用）。"""
    rng = random.Random(20260923)
    now_ms = int(time.time() * 1000)
    day_ms = 24 * 3600 * 1000
    n_runs = 48
    rows = []
    for i in range(n_runs):
        started_at = now_ms - int(day_ms * 14 * (1 - i / n_runs)) - rng.randrange(0, 4 * 3600 * 1000)
        strategy = rng.choice(["fifo", "fifo", "fifo", "priority", "max_concurrent"])
        workers = rng.choice([1, 3, 3, 5])

        base_rows = int(_lognorm(rng, 50000, 0.25))
        t = started_at
        stage_rows = []
        # 少量执行失败：只跑到中途的环节
        failed = i in (7, 31)
        cutoff = rng.choice([4, 6, 8]) if failed else len(STAGE_DEFS)
        for idx, (sid, _name, base_dur) in enumerate(STAGE_DEFS):
            if idx >= cutoff:
                break
            # 个别环节没有数据（约 6%），报表里该环节应按 0 参与
            if not failed and rng.random() < 0.06 and sid not in ("extract",):
                continue
            rc = max(1, int(base_rows * _lognorm(rng, 1.0, 0.05)))
            dur_ms = int(base_dur * rng.uniform(0.7, 1.3) * 1000)
            retries = 1 if (not failed and rng.random() < 0.08) else 0
            if retries:
                dur_ms += int(base_dur * rng.uniform(0.5, 1.0) * 1000)
            stage_rows.append((sid, rc, dur_ms, retries, t))
            t += dur_ms + int(rng.uniform(20, 400))
        status = "FAILED" if failed else "SUCCESS"
        rows.append((started_at, t, status, workers, strategy, stage_rows))

    for started_at, ended_at, status, workers, strategy, stage_rows in rows:
        cur = _conn.execute(
            "INSERT INTO execution(workflow_id, started_at, ended_at, status, workers, strategy) "
            "VALUES(1,?,?,?,?,?)",
            (started_at, ended_at, status, workers, strategy),
        )
        eid = cur.lastrowid
        _conn.executemany(
            "INSERT INTO execution_stage(execution_id, stage_id, row_count, duration_ms, retries, status, started_at, ended_at) "
            "VALUES(?,?,?,?,?,'SUCCESS',?,?)",
            [(eid, sid, rc, dur, rt, st, st + dur) for sid, rc, dur, rt, st in stage_rows],
        )
    _conn.commit()


# ----------------------------------------------------------------------------
# 实时执行落库（execute_workflow 调用）
# ----------------------------------------------------------------------------

def create_execution(workflow_id: int, workers: int, strategy: str, base_rows: int) -> int:
    with _lock:
        cur = _conn.execute(
            "INSERT INTO execution(workflow_id, started_at, status, workers, strategy) VALUES(?,?,?,?,?)",
            (workflow_id, int(time.time() * 1000), "RUNNING", workers, strategy),
        )
        _conn.commit()
        return int(cur.lastrowid)


def record_stage(execution_id: int, stage_id: str, row_count: int, duration_ms: int,
                 retries: int, started_at: float, ended_at: float, status: str = "SUCCESS"):
    with _lock:
        _conn.execute(
            "INSERT INTO execution_stage(execution_id, stage_id, row_count, duration_ms, retries, status, started_at, ended_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (execution_id, stage_id, row_count, int(duration_ms), retries, status,
             int(started_at * 1000), int(ended_at * 1000)),
        )
        _conn.commit()


def finish_execution(execution_id: int, status: str = "SUCCESS"):
    with _lock:
        _conn.execute(
            "UPDATE execution SET status=?, ended_at=? WHERE id=?",
            (status, int(time.time() * 1000), execution_id),
        )
        _conn.commit()


# ----------------------------------------------------------------------------
# 报表查询
#
# 汇总 / 明细 / 趋势三个接口共用同一组过滤条件（start_ms/end_ms/stage_ids），
# 过滤对象统一是 execution.started_at（一次执行的开始时间），保证三处口径一致：
# 汇总里能核对到的数字，明细里一定能逐条对上。
# ----------------------------------------------------------------------------

def get_summary(start_ms, end_ms, stage_ids=None):
    """按环节汇总：以环节字典为骨架 LEFT JOIN，缺数据的环节按 0 返回。

    时间条件必须挂在 JOIN ON 上而不是 WHERE，否则无明细的环节会被整段丢掉。
    """
    if stage_ids:
        placeholders = ",".join("?" * len(stage_ids))
        # 关键：先用时间条件 LEFT JOIN execution，再把明细挂到「环节×执行」对上，
        # 否则时间条件会被外连接绕过，缺数据的环节也会被 WHERE 过滤掉。
        sql = f"""
            SELECT d.stage_id AS stage_id, d.name AS name, d.seq AS seq,
                   COALESCE(SUM(s.row_count), 0)   AS total_rows,
                   COALESCE(SUM(s.duration_ms), 0) AS total_duration_ms,
                   COUNT(s.id) AS execution_count
            FROM stage_def d
            LEFT JOIN execution e ON e.started_at >= ? AND e.started_at <= ?
            LEFT JOIN execution_stage s ON s.stage_id = d.stage_id AND s.execution_id = e.id
            WHERE d.stage_id IN ({placeholders})
            GROUP BY d.stage_id
        """
        rows = _conn.execute(sql, [start_ms, end_ms, *stage_ids]).fetchall()
    else:
        sql = """
            SELECT d.stage_id AS stage_id, d.name AS name, d.seq AS seq,
                   COALESCE(SUM(s.row_count), 0)   AS total_rows,
                   COALESCE(SUM(s.duration_ms), 0) AS total_duration_ms,
                   COUNT(s.id) AS execution_count
            FROM stage_def d
            LEFT JOIN execution e ON e.started_at >= ? AND e.started_at <= ?
            LEFT JOIN execution_stage s ON s.stage_id = d.stage_id AND s.execution_id = e.id
            GROUP BY d.stage_id
        """
        rows = _conn.execute(sql, [start_ms, end_ms]).fetchall()

    grand_duration = sum(r["total_duration_ms"] for r in rows)
    items = []
    for r in rows:
        dur = r["total_duration_ms"]
        items.append({
            "stageId": r["stage_id"],
            "stageName": r["name"],
            "seq": r["seq"],
            "executionCount": r["execution_count"],
            "totalRows": r["total_rows"],
            "totalDurationMs": dur,
            "avgDurationMs": round(dur / r["execution_count"]) if r["execution_count"] else 0,
            # 占比分母是所有环节总耗时，前后端共用同一口径
            "durationRatio": round(dur / grand_duration, 6) if grand_duration else 0,
        })

    meta = _conn.execute(
        "SELECT COUNT(DISTINCT e.id) AS cnt FROM execution e WHERE e.started_at >= ? AND e.started_at <= ?",
        (start_ms, end_ms),
    ).fetchone()
    return {
        "items": items,
        "totalStages": len(items),
        "totalDurationMs": grand_duration,
        "totalRows": sum(it["totalRows"] for it in items),
        "executionCount": meta["cnt"],
    }


def get_details(start_ms, end_ms, stage_ids=None, page=1, page_size=10):
    """明细逐条核对：与汇总完全相同的时间/环节口径，服务端排序分页。"""
    if stage_ids:
        placeholders = ",".join("?" * len(stage_ids))
        join = f"JOIN stage_def d ON d.stage_id = s.stage_id WHERE d.stage_id IN ({placeholders}) AND "
        base_params = [*stage_ids]
    else:
        join = "JOIN stage_def d ON d.stage_id = s.stage_id WHERE "
        base_params = []

    where_sql = "e.started_at >= ? AND e.started_at <= ?"
    count_sql = f"""
        SELECT COUNT(*) FROM execution_stage s
        JOIN execution e ON e.id = s.execution_id
        {join} {where_sql}
    """
    total = _conn.execute(count_sql, [*base_params, start_ms, end_ms]).fetchone()[0]

    list_sql = f"""
        SELECT s.id AS id, s.execution_id AS execution_id, e.status AS execution_status,
               s.stage_id AS stage_id, d.name AS stage_name, d.seq AS seq,
               s.row_count AS row_count, s.duration_ms AS duration_ms,
               s.retries AS retries, s.status AS status,
               s.started_at AS started_at, s.ended_at AS ended_at
        FROM execution_stage s
        JOIN execution e ON e.id = s.execution_id
        {join} {where_sql}
        ORDER BY s.execution_id DESC, d.seq ASC, s.id ASC
        LIMIT ? OFFSET ?
    """
    rows = _conn.execute(
        list_sql, [*base_params, start_ms, end_ms, page_size, (page - 1) * page_size]
    ).fetchall()
    return {
        "total": total,
        "page": page,
        "pageSize": page_size,
        "items": [{
            "id": r["id"],
            "executionId": r["execution_id"],
            "executionStatus": r["execution_status"],
            "stageId": r["stage_id"],
            "stageName": r["stage_name"],
            "rowCount": r["row_count"],
            "durationMs": r["duration_ms"],
            "retries": r["retries"],
            "status": r["status"],
            "startedAt": r["started_at"],
            "endedAt": r["ended_at"],
        } for r in rows],
    }


def get_trend(start_ms, end_ms, limit=10):
    """最近 N 次执行各环节耗时对照：以环节字典为骨架，缺数据环节补 0。"""
    exec_rows = _conn.execute(
        "SELECT id, started_at, status FROM execution WHERE started_at >= ? AND started_at <= ? "
        "ORDER BY started_at DESC, id DESC LIMIT ?",
        (start_ms, end_ms, limit),
    ).fetchall()
    exec_rows = list(reversed(exec_rows))  # 图表从旧到新
    if not exec_rows:
        return {"executions": [], "series": []}

    ids = [r["id"] for r in exec_rows]
    placeholders = ",".join("?" * len(ids))
    stage_rows = _conn.execute(
        f"SELECT execution_id, stage_id, duration_ms FROM execution_stage "
        f"WHERE execution_id IN ({placeholders})",
        ids,
    ).fetchall()
    matrix = {sid: {eid: 0 for eid in ids} for sid in STAGE_IDS}
    for r in stage_rows:
        if r["stage_id"] in matrix:
            matrix[r["stage_id"]][r["execution_id"]] = r["duration_ms"]

    series = [{
        "stageId": sid,
        "stageName": name,
        "values": [matrix[sid][eid] for eid in ids],
    } for sid, name, _ in STAGE_DEFS]
    return {
        "executions": [{"id": r["id"], "startedAt": r["started_at"], "status": r["status"]} for r in exec_rows],
        "series": series,
    }
