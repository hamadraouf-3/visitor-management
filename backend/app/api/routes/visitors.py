from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Query, status

from app.api.deps import (
    ContextDep,
    CreateVisitorAuth,
    DbSession,
    EditVisitorAuth,
    EmailDispatcherDep,
    ReadVisitorsAuth,
    VisitorsServiceDep,
)
from app.email.dispatcher import schedule_deliveries
from app.schemas.common import PageQuery, Paginated
from app.schemas.visitors import Visitor, VisitorCreate, VisitorSearchItem, VisitorSearchQuery, VisitorUpdate
from app.schemas.visits import Visit

router = APIRouter(prefix="/visitors", tags=["visitors"])


@router.get("", response_model=Paginated[VisitorSearchItem])
def search_visitors(
    auth: ReadVisitorsAuth, service: VisitorsServiceDep, query: Annotated[VisitorSearchQuery, Query()]
) -> Paginated[VisitorSearchItem]:
    return service.search(auth, q=query.q, page=query.page, page_size=query.page_size)


@router.post("", response_model=Visitor, status_code=status.HTTP_201_CREATED)
def create_visitor(
    body: VisitorCreate, auth: CreateVisitorAuth, service: VisitorsServiceDep, context: ContextDep
) -> Visitor:
    return service.create(auth, body, context)


@router.get("/{visitor_id}", response_model=Visitor)
def get_visitor(visitor_id: UUID, auth: ReadVisitorsAuth, service: VisitorsServiceDep) -> Visitor:
    return service.get(auth, visitor_id)


@router.patch("/{visitor_id}", response_model=Visitor)
def update_visitor(
    visitor_id: UUID,
    body: VisitorUpdate,
    auth: EditVisitorAuth,
    service: VisitorsServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> Visitor:
    result = service.update(auth, visitor_id, body, context)
    schedule_deliveries(background_tasks, db, dispatcher, result.delivery_jobs)
    return result.payload


@router.get("/{visitor_id}/visits", response_model=Paginated[Visit])
def list_visitor_visits(
    visitor_id: UUID,
    auth: ReadVisitorsAuth,
    service: VisitorsServiceDep,
    query: Annotated[PageQuery, Query()],
) -> Paginated[Visit]:
    return service.history(auth, visitor_id, page=query.page, page_size=query.page_size)
