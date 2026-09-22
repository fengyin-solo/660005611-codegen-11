"""Report APIs: per-stage summary, row-level details and duration trend.

All three query endpoints accept exactly the same filter parameters and build
their WHERE clause from the same helper in ``db``, so the aggregated numbers
and the detail-level numbers always reconcile.
"""

from typing import List, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from . import db

router = APIRouter(prefix="/api/report", tags=["report"])


class SeedRequest(BaseModel):
    runs: int = 50
    days: int = 21
    reset: bool = True


@router.get("/stages")
def get_stages():
    return {"items": db.list_stages()}


@router.get("/summary")
def summary(
    startTime: Optional[float] = Query(None, description="开始时间(epoch秒), 含"),
    endTime: Optional[float] = Query(None, description="结束时间(epoch秒), 含"),
    status: Optional[str] = Query(None, description="执行状态: SUCCESS/FAILED/RUNNING"),
    page: int = Query(1, ge=1),
    pageSize: int = Query(10, ge=1, le=100),
    sortBy: str = Query("stageOrder"),
    sortOrder: str = Query("asc", pattern="^(asc|desc)$"),
):
    return db.get_summary(
        start_time=startTime, end_time=endTime, status=status,
        page=page, page_size=pageSize, sort_by=sortBy, sort_order=sortOrder,
    )


@router.get("/details")
def details(
    startTime: Optional[float] = Query(None),
    endTime: Optional[float] = Query(None),
    status: Optional[str] = Query(None),
    taskId: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    pageSize: int = Query(10, ge=1, le=200),
):
    return db.get_details(
        start_time=startTime, end_time=endTime,
        status=status or None,
        task_id=taskId, page=page, page_size=pageSize,
    )


@router.get("/trend")
def trend(
    startTime: Optional[float] = Query(None),
    endTime: Optional[float] = Query(None),
    status: Optional[str] = Query(None),
    taskId: List[str] = Query(default_factory=list),
    limit: int = Query(10, ge=1, le=50),
):
    return db.get_trend(
        start_time=startTime, end_time=endTime, status=status,
        task_ids=taskId or None, limit=limit,
    )


@router.post("/seed")
def seed(req: SeedRequest):
    return db.seed_demo_data(runs=req.runs, days=req.days, reset=req.reset)
