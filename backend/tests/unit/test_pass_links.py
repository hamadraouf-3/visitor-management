"""The links the backend writes into e-mails, QR codes and API answers (Phase 12, B12-14): a pass link and
a reset link name the company in the query, and the token stays in the fragment, alone. Every parser of a
pass link reads both forms: with the company and, as every earlier link, without a query."""

from urllib.parse import parse_qs, urlsplit

import pytest

from app.core.config import Settings
from app.email.service import company_link
from app.security.tokens import PASS_URL_PATTERN, build_pass_url, extract_pass_token, generate_token

BASE = "https://vms.test/pass"


def test_a_pass_link_names_its_company_in_the_query_and_keeps_the_token_in_the_fragment() -> None:
    token = generate_token()
    url = build_pass_url(BASE, token, "acme-corp")
    assert url == f"https://vms.test/pass?c=acme-corp#{token}"
    parts = urlsplit(url)
    assert (parts.path, parts.query, parts.fragment) == ("/pass", "c=acme-corp", token)
    # The token is nowhere but the fragment, which a browser never sends to a server.
    assert token not in url.split("#", 1)[0] and url.count("#") == 1
    assert extract_pass_token(url) == token


def test_a_pass_link_without_a_company_is_the_form_of_every_earlier_link() -> None:
    token = generate_token()
    for url in (
        build_pass_url(BASE, token),
        build_pass_url(BASE, token, None),
        build_pass_url(BASE, token, ""),
    ):
        assert url == f"https://vms.test/pass#{token}"
        assert extract_pass_token(url) == token


@pytest.mark.parametrize(
    "slug",
    [
        "acme",
        "a",
        "a-b-c-0-9",
        "x" * 80,
        # A slug is lowercase letters, digits and hyphens; whatever else a database may hold cannot become
        # a second parameter, a fragment, a path or a host.
        "a b",
        "a&token=steal",
        "a#fragment",
        "a/../../login",
        "a?b=c",
        "a%23b",
        "شركة",
        'a"><script>',
        "a\nb",
        "@evil.test",
    ],
)
def test_no_company_slug_can_change_what_a_pass_link_is(slug: str) -> None:
    token = generate_token()
    url = build_pass_url(BASE, token, slug)
    assert url.isascii() and " " not in url and "\n" not in url
    parts = urlsplit(url)
    assert (parts.scheme, parts.netloc, parts.path, parts.fragment) == ("https", "vms.test", "/pass", token)
    assert parse_qs(parts.query, strict_parsing=True) == {"c": [slug]}
    assert url.count("#") == 1 and token not in url.split("#", 1)[0]
    # The scanner, the paste field and the shared grammar read it like any pass link.
    assert extract_pass_token(url) == token
    assert PASS_URL_PATTERN.fullmatch(url) is not None


@pytest.mark.parametrize(
    "origin", ["https://visitors.example.com", "http://localhost:5173", "https://[::1]:8443"]
)
def test_the_pass_link_of_any_configured_origin_parses_in_both_forms(origin: str) -> None:
    """QR_BASE_URL is an origin without a path (the settings refuse anything else), so the path of every
    pass link is exactly /pass, with or without the company's query."""
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url="postgresql://u:p@h/d",
        app_base_url=origin,
    )
    assert settings.pass_url_base == f"{origin}/pass"
    token = generate_token()
    for url in (
        build_pass_url(settings.pass_url_base, token, "demo-company"),
        build_pass_url(settings.pass_url_base, token),
    ):
        assert extract_pass_token(url) == token
        assert urlsplit(url).path == "/pass"


@pytest.mark.parametrize(
    "base", ["https://vms.test/app", "https://vms.test/pass", "https://vms.test/?x=1", "https://vms.test/#x"]
)
def test_a_base_url_with_a_path_a_query_or_a_fragment_is_still_refused(base: str) -> None:
    with pytest.raises(ValueError, match="must be an origin"):
        Settings(
            _env_file=None,  # type: ignore[call-arg]
            app_env="test",
            database_url="postgresql://u:p@h/d",
            app_base_url="https://vms.test",
            qr_base_url=base,
        )


def test_a_page_link_names_the_company_before_any_fragment() -> None:
    assert company_link("https://vms.test/reset-password", "acme") == "https://vms.test/reset-password?c=acme"
    assert (
        company_link("https://vms.test/forgot-password", "a b&c")
        == "https://vms.test/forgot-password?c=a%20b%26c"
    )
    reset = company_link("https://vms.test/reset-password", "acme") + "#token=" + "T" * 43
    parts = urlsplit(reset)
    assert (parts.path, parts.query, parts.fragment) == ("/reset-password", "c=acme", "token=" + "T" * 43)
