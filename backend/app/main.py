import asyncio, time, random, json, threading
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import db
from .report import router as report_router

ACTIVE_CLIENTS = []
WORKFLOW_ID = 0
MAIN_LOOP: asyncio.AbstractEventLoop | None = None

# Positions for the DAG canvas, keyed by stage id. Stage metadata
# (name/duration/row volume) lives in db.STAGES as the single source of truth.
STAGE_POSITIONS = [
    (0, 0), (0, 1), (-1, 2), (1, 2), (-1, 3),
    (0.5, 3), (-0.3, 4), (-0.3, 5), (-1, 6), (0.5, 6), (-0.3, 7)
]
STAGE_DEPS = {
    "extract": [],
    "validate": ["extract"],
    "clean_a": ["validate"],
    "clean_b": ["validate"],
    "transform": ["clean_a"],
    "enrich": ["clean_a", "clean_b"],
    "aggregate": ["transform", "enrich"],
    "quality": ["aggregate"],
    "export_db": ["quality"],
    "export_report": ["quality"],
    "notify": ["export_db", "export_report"],
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global MAIN_LOOP
    MAIN_LOOP = asyncio.get_running_loop()
    db.init_db()
    # Seed a small history so the report has data on first open.
    if db.execution_count() == 0:
        db.seed_demo_data(runs=45, days=21, reset=False)
    yield


app = FastAPI(title="DAG Workflow Engine", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(report_router)

class WorkflowCreate(BaseModel):
    name: str = "data-pipeline"

class RunRequest(BaseModel):
    workflowId: int
    workers: int = 3
    strategy: str = "fifo"


def generate_dag_workflow(name: str):
    """Create a realistic DAG pipeline"""
    nodes = []
    for i, s in enumerate(db.STAGES):
        px, py = STAGE_POSITIONS[i]
        nodes.append({
            "id": s["id"], "name": s["name"], "deps": STAGE_DEPS[s["id"]],
            "x": px * 2.5 + 2.5, "y": py * 0.9,
            "status": "PENDING", "retries": 0, "startTime": None, "endTime": None,
        })

    edges = []
    for n in nodes:
        for d in n["deps"]:
            edges.append([d, n["id"]])

    return {
        "nodes": nodes, "edges": edges,
        "durations": {s["id"]: s["base_duration_ms"] / 1000.0 for s in db.STAGES},
    }


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
    execution_id = db.create_execution(req.workflowId, "data-pipeline")
    # The simulation runs in a worker thread; push WebSocket messages onto the
    # main event loop captured during startup.
    t = threading.Thread(
        target=execute_workflow, args=(dag, req.workers, req.strategy, execution_id, MAIN_LOOP),
        daemon=True,
    )
    t.start()
    return {
        "workflow": {"id": req.workflowId, "name": "workflow", "nodes": dag["nodes"], "edges": dag["edges"]},
        "logs": [], "circuitBreakers": [], "completed": False
    }


def execute_workflow(dag, workers, strategy, execution_id, loop):
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
    run_factor = random.uniform(0.82, 1.18)  # shared data-volume factor this run

    def send_update(completed_flag=False, final_status="SUCCESS"):
        payload = {
            "workflow": {"id": 1, "name": "workflow", "nodes": nodes, "edges": edges},
            "logs": logs[-30:],
            "circuitBreakers": [{"taskId": k, **v} for k, v in cb_state.items()],
            "completed": completed_flag,
            "status": final_status,
        }
        for ws in ACTIVE_CLIENTS:
            try:
                asyncio.run_coroutine_threadsafe(ws.send_text(json.dumps(payload)), loop)
            except Exception:
                pass

    def abort_workflow(failed_tid):
        """Retries exhausted on failed_tid: downstream stages never run."""
        node = node_map[failed_tid]
        node["status"] = "FAILED"
        node["endTime"] = time.time()
        for n in nodes:
            if n["status"] in ("PENDING", "RUNNING") and n["id"] != failed_tid:
                n["status"] = "FAILED"
        db.finish_execution(execution_id, "FAILED")
        logs.append({"taskId": failed_tid, "status": "FAILED", "timestamp": time.time(),
                     "message": f"失败 {node['name']}，工作流终止"})
        send_update(True, "FAILED")

    while ready or running_tasks:
        # Start tasks
        while ready and len(running_tasks) < workers:
            tid = ready.popleft()
            node = node_map[tid]
            cb = cb_state[tid]
            if cb["state"] == "OPEN" and time.time() < cb["cooldownUntil"]:
                ready.appendleft(tid)
                break
            if cb["state"] == "OPEN":
                cb["state"] = "HALF_OPEN"

            node["status"] = "RUNNING"
            node["startTime"] = time.time()

            # Simulate task execution (random success/failure)
            will_fail = random.random() < 0.12  # 12% failure rate
            runtime = durations.get(tid, 1.5) * random.uniform(0.7, 1.3)
            running_tasks[tid] = {
                "start": node["startTime"],
                "end_time": time.time() + runtime,
                "will_fail": will_fail,
            }
            logs.append({"taskId": tid, "status": "RUNNING", "timestamp": node["startTime"],
                         "message": f"开始执行 {node['name']}"})

        # Check completed tasks
        now = time.time()
        finished = []
        aborted = False
        for tid, info in running_tasks.items():
            if now < info["end_time"]:
                continue
            node = node_map[tid]
            duration_ms = (now - info["start"]) * 1000.0
            if info["will_fail"] and node["retries"] < 3:
                node["retries"] += 1
                node["status"] = "PENDING"
                ready.appendleft(tid)
                cb = cb_state[tid]
                cb["failureCount"] += 1
                logs.append({"taskId": tid, "status": "FAILED", "timestamp": now,
                             "message": f"重试 {node['retries']}/3"})
                if cb["failureCount"] >= failure_threshold:
                    cb["state"] = "OPEN"
                    cb["cooldownUntil"] = now + 5
                    logs.append({"taskId": tid, "status": "CIRCUIT_OPEN", "timestamp": now,
                                 "message": f"熔断! {failure_threshold}次连续失败"})
            elif info["will_fail"]:
                # Retries exhausted — persist the failed stage, then stop.
                db.record_task_execution(
                    execution_id, tid, "FAILED",
                    db.simulate_row_count(tid, run_factor), duration_ms,
                    retries=node["retries"], start_time=info["start"], end_time=now,
                )
                finished.append(tid)
                abort_workflow(tid)
                aborted = True
                break
            else:
                node["status"] = "SUCCESS"
                node["endTime"] = now
                completed.add(tid)
                cb_state[tid]["failureCount"] = 0
                cb_state[tid]["state"] = "CLOSED"
                db.record_task_execution(
                    execution_id, tid, "SUCCESS",
                    db.simulate_row_count(tid, run_factor), duration_ms,
                    retries=node["retries"], start_time=info["start"], end_time=now,
                )
                logs.append({"taskId": tid, "status": "SUCCESS", "timestamp": now,
                             "message": f"完成 {node['name']}"})
                for next_tid in adj[tid]:
                    in_degree[next_tid] -= 1
                    if in_degree[next_tid] == 0:
                        ready.append(next_tid)
                finished.append(tid)

        for tid in finished:
            running_tasks.pop(tid, None)

        if aborted:
            return

        send_update()
        if len(completed) == len(nodes):
            break

        time.sleep(0.3)

    db.finish_execution(execution_id, "SUCCESS")
    send_update(True, "SUCCESS")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ACTIVE_CLIENTS.append(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if ws in ACTIVE_CLIENTS:
            ACTIVE_CLIENTS.remove(ws)
