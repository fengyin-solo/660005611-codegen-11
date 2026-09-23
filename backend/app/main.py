import asyncio, time, random, json, threading, math
from collections import defaultdict, deque
from typing import Optional, List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from . import report_store

app = FastAPI(title="DAG Workflow Engine")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

report_store.init_db()

ACTIVE_CLIENTS = []
WORKFLOW_ID = 0

class WorkflowCreate(BaseModel):
    name: str = "data-pipeline"

class RunRequest(BaseModel):
    workflowId: int
    workers: int = 3
    strategy: str = "fifo"


def generate_dag_workflow(name: str):
    """Create a realistic DAG pipeline"""
    nodes = [
        {"id": "extract", "name": "数据提取", "deps": [], "duration": 2.0},
        {"id": "validate", "name": "数据校验", "deps": ["extract"], "duration": 1.5},
        {"id": "clean_a", "name": "清洗分支A", "deps": ["validate"], "duration": 1.8},
        {"id": "clean_b", "name": "清洗分支B", "deps": ["validate"], "duration": 1.2},
        {"id": "transform", "name": "数据转换", "deps": ["clean_a"], "duration": 3.0},
        {"id": "enrich", "name": "数据增强", "deps": ["clean_a", "clean_b"], "duration": 2.0},
        {"id": "aggregate", "name": "聚合计算", "deps": ["transform", "enrich"], "duration": 2.5},
        {"id": "quality", "name": "质量检查", "deps": ["aggregate"], "duration": 1.0},
        {"id": "export_db", "name": "入库", "deps": ["quality"], "duration": 1.8},
        {"id": "export_report", "name": "报表生成", "deps": ["quality"], "duration": 2.2},
        {"id": "notify", "name": "通知", "deps": ["export_db", "export_report"], "duration": 0.5},
    ]
    positions = [
        (0, 0), (0, 1), (-1, 2), (1, 2), (-1, 3),
        (0.5, 3), (-0.3, 4), (-0.3, 5), (-1, 6), (0.5, 6), (-0.3, 7)
    ]
    for i, n in enumerate(nodes):
        n["x"] = positions[i][0] * 2.5 + 2.5
        n["y"] = positions[i][1] * 0.9
        n["status"] = "PENDING"
        n["retries"] = 0
        n["startTime"] = None
        n["endTime"] = None

    edges = []
    for n in nodes:
        for d in n["deps"]:
            edges.append([d, n["id"]])

    return {"nodes": [{
        "id": n["id"], "name": n["name"], "deps": n["deps"],
        "x": n["x"], "y": n["y"], "status": n["status"],
        "startTime": None, "endTime": None, "retries": n["retries"]
    } for n in nodes], "edges": edges, "durations": {n["id"]: n["duration"] for n in nodes}}


@app.post("/api/workflow")
def create_workflow(req: WorkflowCreate):
    global WORKFLOW_ID
    WORKFLOW_ID += 1
    dag = generate_dag_workflow(req.name)
    return {"id": WORKFLOW_ID, "name": req.name, "nodes": dag["nodes"], "edges": dag["edges"],
            "_durations": dag["durations"]}


@app.post("/api/run")
def run_workflow(req: RunRequest):
    dag = generate_dag_workflow("workflow")
    # 本次执行的条数基数（近似对数正态，模拟不同批次数据量）
    base_rows = max(1, int(50000 * math.exp(random.gauss(0, 0.25))))
    execution_id = report_store.create_execution(req.workflowId, req.workers, req.strategy, base_rows)
    t = threading.Thread(target=execute_workflow,
                         args=(dag, req.workers, req.strategy, execution_id, base_rows), daemon=True)
    t.start()
    return {
        "workflow": {"id": req.workflowId, "name": "workflow", "nodes": dag["nodes"], "edges": dag["edges"]},
        "logs": [], "circuitBreakers": [], "completed": False
    }


def execute_workflow(dag, workers, strategy, execution_id, base_rows):
    nodes = dag["nodes"]
    durations = dag["durations"]
    edges = dag["edges"]
    in_degree = defaultdict(int)
    adj = defaultdict(list)
    for u, v in edges:
        in_degree[v] += 1
        adj[u].append(v)

    # BFS topological sort
    ready = deque([n["id"] for n in nodes if in_degree[n["id"]] == 0])
    node_map = {n["id"]: n for n in nodes}
    logs = []
    cb_state = defaultdict(lambda: {"failureCount": 0, "state": "CLOSED", "cooldownUntil": 0})
    failure_threshold = 3
    running_tasks = {}
    completed = set()
    failed = set()

    def send_update(completed_flag=False):
        payload = {
            "workflow": {"id": 1, "name": "workflow", "nodes": nodes, "edges": edges},
            "logs": logs[-30:],
            "circuitBreakers": [{"taskId": k, **v} for k, v in cb_state.items()],
            "completed": completed_flag
        }
        for ws in ACTIVE_CLIENTS:
            try: asyncio.run_coroutine_threadsafe(ws.send_text(json.dumps(payload)), asyncio.get_event_loop())
            except: pass
        time.sleep(0.3)

    while ready or running_tasks:
        # Start tasks
        while ready and len(running_tasks) < workers:
            tid = ready.popleft()
            node = node_map[tid]
            cb = cb_state[tid]
            if cb["state"] == "OPEN" and time.time() < cb["cooldownUntil"]:
                ready.appendleft(tid)
                continue
            if cb["state"] == "OPEN":
                cb["state"] = "HALF_OPEN"

            node["status"] = "RUNNING"
            node["startTime"] = time.time()

            # Simulate task execution (random success/failure)
            will_fail = random.random() < 0.12  # 12% failure rate
            runtime = durations.get(tid, 1.5) * random.uniform(0.7, 1.3)
            running_tasks[tid] = {
                "end_time": time.time() + runtime,
                "will_fail": will_fail,
                "retries": node["retries"]
            }
            logs.append({"taskId": tid, "status": "RUNNING", "timestamp": time.time(), "message": f"开始执行 {node['name']}"})

        # Check completed tasks
        now = time.time()
        finished = []
        for tid, info in running_tasks.items():
            if now >= info["end_time"]:
                node = node_map[tid]
                if info["will_fail"] and node["retries"] < 3:
                    node["retries"] += 1
                    node["status"] = "PENDING"
                    ready.appendleft(tid)
                    cb = cb_state[tid]
                    cb["failureCount"] += 1
                    logs.append({"taskId": tid, "status": "FAILED", "timestamp": now, "message": f"重试 {node['retries']}/3"})
                    if cb["failureCount"] >= failure_threshold:
                        cb["state"] = "OPEN"
                        cb["cooldownUntil"] = now + 5
                        logs.append({"taskId": tid, "status": "CIRCUIT_OPEN", "timestamp": now, "message": f"熔断! {failure_threshold}次连续失败"})
                elif info["will_fail"]:
                    # 重试次数用尽：标记最终失败并落库（耗时/重试次数仍可在报表核对），
                    # 不再放回队列，避免执行无限挂起
                    node["status"] = "FAILED"
                    node["endTime"] = now
                    failed.add(tid)
                    duration_ms = int((now - node["startTime"]) * 1000)
                    try:
                        report_store.record_stage(
                            execution_id, tid, 0, duration_ms, node["retries"],
                            node["startTime"], now, status="FAILED")
                    except Exception:
                        pass
                    logs.append({"taskId": tid, "status": "FAILED", "timestamp": now, "message": f"{node['name']} 最终失败(重试{node['retries']}次)"})
                else:
                    node["status"] = "SUCCESS"
                    node["endTime"] = now
                    completed.add(tid)
                    cb_state[tid]["failureCount"] = 0
                    cb_state[tid]["state"] = "CLOSED"
                    # 落库该环节明细：耗时取最近一次开始到结束，条数随数据量基数浮动
                    row_count = max(1, int(base_rows * random.uniform(0.92, 1.08)))
                    duration_ms = int((now - node["startTime"]) * 1000)
                    try:
                        report_store.record_stage(
                            execution_id, tid, row_count, duration_ms, node["retries"],
                            node["startTime"], now)
                    except Exception:
                        pass
                    logs.append({"taskId": tid, "status": "SUCCESS", "timestamp": now, "message": f"完成 {node['name']}"})
                    for next_tid in adj[tid]:
                        in_degree[next_tid] -= 1
                        if in_degree[next_tid] == 0:
                            ready.append(next_tid)
                finished.append(tid)

        for tid in finished:
            del running_tasks[tid]

        send_update()
        if failed:
            break
        if len(completed) == len(nodes):
            break

    report_store.finish_execution(execution_id, "FAILED" if failed else "SUCCESS")
    send_update(True)


# ----------------------------------------------------------------------------
# 执行报表
#
# 三个接口共用 start/end（毫秒时间戳）与 stageIds 过滤条件，
# 过滤对象统一为执行开始时间 execution.started_at，保证汇总、明细、趋势口径一致。
# ----------------------------------------------------------------------------

def _parse_range(start: Optional[int], end: Optional[int]):
    now_ms = int(time.time() * 1000)
    day_ms = 24 * 3600 * 1000
    return start if start is not None else now_ms - 14 * day_ms, end if end is not None else now_ms


@app.get("/api/reports/summary")
def report_summary(
    start: Optional[int] = None, end: Optional[int] = None,
    stageIds: Optional[str] = Query(None, description="逗号分隔的环节 id"),
):
    start_ms, end_ms = _parse_range(start, end)
    ids = [s for s in (stageIds.split(",") if stageIds else []) if s] or None
    return report_store.get_summary(start_ms, end_ms, ids)


@app.get("/api/reports/details")
def report_details(
    start: Optional[int] = None, end: Optional[int] = None,
    stageIds: Optional[str] = Query(None, description="逗号分隔的环节 id"),
    page: int = Query(1, ge=1), pageSize: int = Query(10, ge=1, le=200),
):
    start_ms, end_ms = _parse_range(start, end)
    ids = [s for s in (stageIds.split(",") if stageIds else []) if s] or None
    return report_store.get_details(start_ms, end_ms, ids, page, pageSize)


@app.get("/api/reports/trend")
def report_trend(
    start: Optional[int] = None, end: Optional[int] = None,
    limit: int = Query(10, ge=1, le=50),
):
    start_ms, end_ms = _parse_range(start, end)
    return report_store.get_trend(start_ms, end_ms, limit)


@app.get("/api/reports/stages")
def report_stages():
    return {"items": [{"stageId": sid, "stageName": name, "seq": i}
                      for i, (sid, name, _) in enumerate(report_store.STAGE_DEFS)]}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ACTIVE_CLIENTS.append(ws)
    try:
        while True: await ws.receive_text()
    except:
        if ws in ACTIVE_CLIENTS: ACTIVE_CLIENTS.remove(ws)