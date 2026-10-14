from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.models import UserSession
from tests.support import Api, World, audit_rows, error_code


def _session_row(db: Session, user_id) -> UserSession:
    db.expire_all()
    return db.scalars(
        select(UserSession).where(UserSession.user_id == user_id).order_by(UserSession.created_at.desc())
    ).first()


def test_me_requires_authentication(client: TestClient) -> None:
    response = Api(client).get("/auth/me")
    assert response.status_code == 401
    assert response.json()["error"] == {
        "code": "NOT_AUTHENTICATED",
        "message": "Please sign in.",
        "details": {},
    }


def test_me_returns_current_user(client: TestClient, world: World) -> None:
    api = Api(client)
    api.login(world.a.employee.email)
    response = api.get("/auth/me")
    assert response.status_code == 200
    assert response.json()["user"]["email"] == world.a.employee.email
    assert response.json()["user"]["phone"] == "+962 79 000 0001"


def test_garbage_session_cookie_is_rejected(client: TestClient) -> None:
    client.cookies.set("__Host-vms_session", "not a token")
    assert Api(client).get("/auth/me").status_code == 401


def test_logout_revokes_session_and_clears_cookies(client: TestClient, world: World, db: Session) -> None:
    api = Api(client)
    api.login(world.a.employee.email)
    stolen = api.session_token

    response = api.post("/auth/logout")
    assert response.status_code == 204
    set_cookies = " ".join(response.headers.get_list("set-cookie")).lower()
    assert "__host-vms_session=" in set_cookies and "max-age=0" in set_cookies
    assert _session_row(db, world.a.employee.id).revoked_at is not None
    assert len(audit_rows(db, "AUTH_LOGOUT", actor_user_id=world.a.employee.id)) == 1

    replay = TestClient(client.app, base_url="https://testserver")
    replay.cookies.set("__Host-vms_session", stolen)
    assert Api(replay).get("/auth/me").status_code == 401


def test_idle_timeout(client: TestClient, world: World, clock: FakeClock) -> None:
    api = Api(client)
    api.login(world.a.employee.email)
    clock.advance(minutes=239)
    assert api.get("/auth/me").status_code == 200  # activity extends the idle window
    clock.advance(minutes=239)
    assert api.get("/auth/me").status_code == 200
    clock.advance(minutes=240, seconds=1)
    assert api.get("/auth/me").status_code == 401


def test_absolute_expiry_despite_activity(client: TestClient, world: World, clock: FakeClock) -> None:
    api = Api(client)
    api.login(world.a.employee.email)
    for _ in range(5):  # 5 x 2h = 10h of continuous use
        clock.advance(hours=2)
        assert api.get("/auth/me").status_code == 200
    clock.advance(hours=2, seconds=1)  # 12h after login
    assert api.get("/auth/me").status_code == 401


def test_background_refresh_does_not_extend_idle(client: TestClient, world: World, clock: FakeClock) -> None:
    api = Api(client)
    api.login(world.a.receptionist.email)
    background = {"X-Background-Refresh": "1"}
    for _ in range(15):  # polling for 225 minutes
        clock.advance(minutes=15)
        assert api.get("/auth/me", headers=background).status_code == 200
    clock.advance(minutes=15, seconds=1)  # 240 min since the last real activity
    assert api.get("/auth/me", headers=background).status_code == 401


def test_last_seen_is_written_at_most_once_per_minute(
    client: TestClient, world: World, db: Session, clock: FakeClock
) -> None:
    api = Api(client)
    api.login(world.a.employee.email)
    first_seen = _session_row(db, world.a.employee.id).last_seen_at

    clock.advance(seconds=30)
    api.get("/auth/me")
    assert _session_row(db, world.a.employee.id).last_seen_at == first_seen

    clock.advance(seconds=31)
    api.get("/auth/me")
    assert _session_row(db, world.a.employee.id).last_seen_at > first_seen


def test_deactivated_user_session_stops_working(client: TestClient, world: World, db: Session) -> None:
    api = Api(client)
    api.login(world.a.employee.email)
    world.a.employee.is_active = False
    db.commit()
    assert api.get("/auth/me").status_code == 401


def test_api_rate_limit_per_user(app, client: TestClient, world: World, db: Session) -> None:
    api = Api(client)
    api.login(world.a.employee.email)
    limit = app.state.settings.rate_limit_api_per_minute
    for _ in range(limit):
        assert api.get("/auth/me").status_code == 200
    response = api.get("/auth/me")
    assert response.status_code == 429
    assert error_code(response) == "RATE_LIMITED"
    assert "Retry-After" in response.headers
    rows = audit_rows(db, "RATE_LIMITED", actor_user_id=world.a.employee.id)
    assert rows[-1].meta["policy"] == "api_per_user"


def test_session_rows_record_client_details(client: TestClient, world: World, db: Session) -> None:
    Api(client).client.headers["User-Agent"] = "Kiosk/1.0"
    Api(client).login(world.a.employee.email)
    row = _session_row(db, world.a.employee.id)
    assert str(row.ip_address) == "203.0.113.10"
    assert row.user_agent == "Kiosk/1.0"
    assert row.expires_at - row.created_at == timedelta(hours=12)
    assert len(row.token_hash) == 64 and len(row.csrf_token_hash) == 64
