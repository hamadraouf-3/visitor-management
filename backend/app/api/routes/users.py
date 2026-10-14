from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Query, status

from app.api.deps import (
    AdminAuth,
    ContextDep,
    CurrentAuth,
    DbSession,
    EmailDispatcherDep,
    UsersServiceDep,
)
from app.email.dispatcher import schedule_deliveries
from app.schemas.common import Paginated
from app.schemas.users import Host, HostSearchQuery, User, UserCreate, UserListQuery, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/hosts", response_model=list[Host])
def list_hosts(
    auth: CurrentAuth, service: UsersServiceDep, query: Annotated[HostSearchQuery, Query()]
) -> list[Host]:
    return [Host.model_validate(user) for user in service.list_hosts(auth, q=query.q)]


@router.get("", response_model=Paginated[User])
def list_users(
    auth: AdminAuth, service: UsersServiceDep, query: Annotated[UserListQuery, Query()]
) -> Paginated[User]:
    result = service.list_users(
        auth,
        q=query.q,
        roles=query.role,
        is_active=query.is_active,
        page=query.page,
        page_size=query.page_size,
    )
    return Paginated[User](
        items=[User.model_validate(user) for user in result.items],
        page=result.page,
        page_size=result.page_size,
        total=result.total,
    )


@router.post("", response_model=User, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, auth: AdminAuth, service: UsersServiceDep, context: ContextDep) -> User:
    return User.model_validate(service.create_user(auth, body, context))


@router.get("/{user_id}", response_model=User)
def get_user(user_id: UUID, auth: AdminAuth, service: UsersServiceDep) -> User:
    return User.model_validate(service.get_user(auth, user_id))


@router.patch("/{user_id}", response_model=User)
def update_user(
    user_id: UUID,
    body: UserUpdate,
    auth: AdminAuth,
    service: UsersServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> User:
    result = service.update_user(auth, user_id, body, context)
    schedule_deliveries(background_tasks, db, dispatcher, result.delivery_jobs)
    payload = User.model_validate(result.user)
    if result.cancelled_visits is not None:
        payload.cancelled_visits = result.cancelled_visits
    return payload
