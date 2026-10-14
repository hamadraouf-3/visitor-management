from fastapi import APIRouter, Request

from app.core.errors import ServiceBusy
from app.schemas.system import Health
from app.services.health import DatabaseProbe

router = APIRouter(tags=["health"])


@router.get("/health", response_model=Health)
async def health(request: Request) -> Health:
    """Liveness plus database reachability; 503 SERVICE_BUSY when the database is down or does not answer
    within 3 s. Runs on the event loop and checks the database outside the request worker threads
    (`DatabaseProbe`), so it answers even while every request thread waits for the database."""
    probe: DatabaseProbe = request.app.state.database_probe
    if not await probe.is_available():
        raise ServiceBusy(details={"database": "unavailable"})
    return Health(status="ok", database="ok")
