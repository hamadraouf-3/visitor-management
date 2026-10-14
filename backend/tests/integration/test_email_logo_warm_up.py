"""The e-mails' logos drawn ahead of the requests that send them (B13-7), on real, separately committing
connections: the application as `python -m app.serve` runs it (`create_served_app`) draws every active
company's logos from the process's first write, in a thread of its own; an application a test builds
draws nothing ahead.
"""

import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core import time as app_time
from app.core.config import Settings
from app.core.png import sanitize_png
from app.email import logos
from app.email.logos import DARK_HEADER, LIGHT_HEADER, LogoWarmUp, RenditionCache
from app.email.providers.memory import MemoryProvider
from app.main import create_app
from app.models import BrandAssetKind, Company
from app.repositories.brand import CompanyBrandRepository
from app.security.passwords import Argon2Parameters, PasswordHasherService
from app.services.brand import IMAGE_LIMITS
from tests.png_support import drawn_logo
from tests.support import TEST_CLIENT_ADDRESS, unique

pytestmark = pytest.mark.committed

FAST_ARGON2 = Argon2Parameters(time_cost=1, memory_cost_kib=1024, parallelism=1)


@pytest.fixture
def cache(monkeypatch: pytest.MonkeyPatch) -> RenditionCache:
    """The process's store of renditions, empty for this test."""
    fresh = RenditionCache()
    monkeypatch.setattr(logos, "RENDITIONS", fresh)
    return fresh


def _company(maker: sessionmaker[Session], *, active: bool, images: dict[BrandAssetKind, str]) -> uuid.UUID:
    with maker() as db:
        company = Company(
            name="Warm Co",
            slug=unique("warm"),
            timezone="Asia/Amman",
            is_active=active,
            deactivated_at=None if active else app_time.now(),
        )
        db.add(company)
        db.flush()
        for kind, name in images.items():
            image = sanitize_png(drawn_logo(name), IMAGE_LIMITS[kind])
            CompanyBrandRepository(db).put(
                company.id,
                kind,
                content=image.data,
                width=image.width,
                height=image.height,
                sha256=uuid.uuid4().hex * 2,
                version=uuid.uuid4().hex[:16],
                now=app_time.now(),
            )
        db.commit()
        return company.id


@pytest.fixture
def served(
    committed_settings: Settings,
    committed_engine: Engine,
    committed_session_factory: sessionmaker[Session],
    cache: RenditionCache,
) -> FastAPI:
    """The application as `python -m app.serve` runs it, drawing into this test's store."""
    return create_app(
        committed_settings,
        engine=committed_engine,
        password_hasher=PasswordHasherService(FAST_ARGON2, max_concurrency=2),
        email_provider=MemoryProvider(),
        warm_email_logos=True,
    )


def test_the_first_write_draws_every_active_company_s_logos_ahead(
    served: FastAPI, committed_session_factory: sessionmaker[Session], cache: RenditionCache
) -> None:
    maker = committed_session_factory
    _company(maker, active=True, images={BrandAssetKind.LOGO: "navy", BrandAssetKind.LOGO_DARK: "mark"})
    _company(maker, active=False, images={BrandAssetKind.LOGO: "gold"})
    _company(maker, active=True, images={BrandAssetKind.LOGO_DARK: "gold"})  # a dark logo alone: none sent
    warm_up: LogoWarmUp = served.state.service_environment.logo_warm_up
    client = TestClient(served, base_url="https://testserver", client=TEST_CLIENT_ADDRESS)
    # A read does not start it: the read services behind nginx take nothing else.
    assert client.get("/api/v1/health").status_code in (200, 503)
    assert warm_up.started is None
    # The first write does, in a thread of its own, and the request does not wait for it.
    response = client.post("/api/v1/auth/login", json={"email": "nobody@warm.test", "password": "x" * 12})
    assert response.status_code in (401, 422, 429)
    thread = warm_up.started
    assert thread is not None and thread.daemon
    thread.join(60)
    assert not thread.is_alive()
    found = cache.drawn
    # The bank's renditions are there (drawn by the warm-up, found by an e-mail); the deactivated
    # company's and a dark logo without a light one were not drawn.
    cache.rendition(sanitize_png(drawn_logo("navy"), IMAGE_LIMITS[BrandAssetKind.LOGO]).data, LIGHT_HEADER)
    cache.rendition(sanitize_png(drawn_logo("mark"), IMAGE_LIMITS[BrandAssetKind.LOGO]).data, DARK_HEADER)
    assert cache.drawn == found
    cache.rendition(sanitize_png(drawn_logo("gold"), IMAGE_LIMITS[BrandAssetKind.LOGO]).data, LIGHT_HEADER)
    assert cache.drawn == found + 1
    # Once per process.
    client.post("/api/v1/auth/login", json={"email": "nobody@warm.test", "password": "x" * 12})
    assert warm_up.started is thread


def test_an_application_a_test_builds_draws_nothing_ahead(
    committed_settings: Settings, committed_engine: Engine, committed_session_factory: sessionmaker[Session]
) -> None:
    app = create_app(committed_settings, engine=committed_engine, email_provider=MemoryProvider())
    assert app.state.service_environment.logo_warm_up is None
