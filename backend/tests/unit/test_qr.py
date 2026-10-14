"""Pass QR codes (contract §6, §9): the PNG is decoded (`tests.qr_png`, a small PNG reader, no image library)
and its module grid compared with segno's symbol for the exact pass URL, so the payload is the pass URL and
nothing else. Plus the token format and unpredictability."""

import re
import uuid
from datetime import UTC, datetime, timedelta

import segno

from app.core.config import Settings
from app.core.qr import QR_QUIET_ZONE, QR_SCALE, qr_matrix, qr_png
from app.email.rendering import EmailRenderer
from app.email.service import (
    LOGO_CONTENT_ID,
    NO_BRAND_IMAGES,
    NO_TEMPLATE_TEXTS,
    QR_CONTENT_ID,
    EmailService,
)
from app.models import Company, Visit
from app.security.tokens import build_pass_url, generate_token, hash_token
from tests.qr_png import decode_png, qr_modules

# A pass link (B12-14): the company's slug in the query, the token alone in the fragment.
PASS_URL_SHAPE = re.compile(r"https://vms\.test/pass\?c=demo#[A-Za-z0-9_-]{43}")


def test_png_encodes_exactly_the_payload() -> None:
    url = build_pass_url("https://vms.test/pass", generate_token())
    png = qr_png(url)
    assert qr_modules(png) == qr_matrix(url)
    symbol = segno.make(url, error="m", boost_error=False, micro=False)
    assert symbol.error == "M" and not symbol.is_micro
    assert len(decode_png(png)) == (symbol.symbol_size(scale=1, border=0)[0] + 2 * QR_QUIET_ZONE) * QR_SCALE
    # A different payload gives a different symbol, so the comparison above is meaningful.
    assert qr_matrix(url) != qr_matrix(url[:-1] + ("A" if url[-1] != "A" else "B"))


def test_invitation_qr_carries_only_the_pass_url() -> None:
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url="postgresql://u:p@h/d",
        app_base_url="https://vms.test",
        email_from="Visitors <no-reply@vms.test>",
    )
    company = Company(
        id=uuid.uuid4(), name="Mawdoo3", slug="demo", timezone="Asia/Amman", address="1 Main St"
    )
    start = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)
    visit = Visit(
        id=uuid.uuid4(),
        company_id=company.id,
        visitor_name="Very Private Person",
        visitor_company_name="Secret Corp",
        host_name="Omar Khalil",
        department_name="Finance",
        purpose="Confidential merger talks",
        scheduled_start=start,
        scheduled_end=start + timedelta(hours=1),
        window_start=start - timedelta(hours=1),
        window_end=start + timedelta(hours=2),
    )
    token = generate_token()

    class _Messages:
        def add(self, message):
            return message

    service = EmailService(
        None,  # type: ignore[arg-type]
        settings=settings,
        renderer=EmailRenderer(),
        provider_name="memory",
        template_texts=NO_TEMPLATE_TEXTS,
        brand_images=NO_BRAND_IMAGES,
    )
    service.messages = _Messages()  # type: ignore[assignment]
    job = service.queue_visitor_invitation(
        visit, token, company=company, recipient="guest@example.com", host_email="omar@demo.test"
    )
    # The pass's QR code: the only image of a company without a logo (B12-12).
    [image] = job.email.inline_images
    assert image.content_id == QR_CONTENT_ID and image.mime_type == "image/png"
    assert LOGO_CONTENT_ID not in job.email.html
    url = job.email.pass_url
    assert url is not None and PASS_URL_SHAPE.fullmatch(url) and url.endswith(f"#{token}")
    assert url == build_pass_url("https://vms.test/pass", token, company.slug)
    assert qr_modules(image.content) == qr_matrix(url)
    for private in ("Very Private Person", "Secret Corp", "Omar Khalil", "Confidential", "guest@example.com"):
        assert private not in url
    assert f'src="cid:{QR_CONTENT_ID}"' in job.email.html


def test_tokens_are_unpredictable_and_only_their_hash_is_kept() -> None:
    tokens = [generate_token() for _ in range(2000)]
    assert len(set(tokens)) == len(tokens)
    assert all(re.fullmatch(r"[A-Za-z0-9_-]{43}", token) for token in tokens)  # 256 bits, URL-safe
    # Every position varies: nothing is a fixed prefix or a counter.
    assert all(len({token[i] for token in tokens}) > 32 for i in range(42))
    digest = hash_token(tokens[0])
    assert re.fullmatch(r"[0-9a-f]{64}", digest) and tokens[0] not in digest
