"""Offline sync for the account's own data.

The client keeps a full IndexedDB mirror and a queue of mutations. It POSTs the
queue to ``/api/sync/push`` (each mutation in its own savepoint, so one bad one
never sinks the batch), then GETs ``/api/sync/pull?cursor=<rev>`` until
``has_more`` is false. See app/syncing.py for how conflicts resolve.
"""

import logging
from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy.orm import Session as DBSession

from ..database import DB
from ..schemas import SyncPushRequest, SyncPushResponse, SyncResult
from ..security import CurrentUser
from ..syncing import Refused, Scope, apply, pull

router = APIRouter(prefix="/api/sync", tags=["sync"])
logger = logging.getLogger("uvicorn.error")


def push_mutations(db: DBSession, payload: SyncPushRequest, scope: Scope) -> SyncPushResponse:
    results: list[SyncResult] = []
    for m in payload.mutations:
        try:
            with db.begin_nested():
                status = apply(db, m, scope)
                db.flush()
            results.append(SyncResult(op_id=m.op_id, status=status))
        except Refused as exc:
            results.append(SyncResult(op_id=m.op_id, status="error", detail=str(exc)))
        except Exception as exc:  # report per mutation, keep going
            logger.exception("sync push failed for %s %s (op %s)", m.entity, m.action, m.op_id)
            results.append(SyncResult(op_id=m.op_id, status="error", detail=f"Server error: {exc}"))
    db.commit()
    return SyncPushResponse(results=results)


@router.post("/push", response_model=SyncPushResponse)
def push(payload: SyncPushRequest, db: DB, user: CurrentUser):
    return push_mutations(db, payload, Scope(owner=user, actor=user.email))


@router.get("/pull")
def pull_changes(
    db: DB,
    user: CurrentUser,
    cursor: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=20000)] = 5000,
) -> dict:
    return pull(db, cursor, limit, owner_id=user.id)
