"""Opaque bearer tokens (sessions, CSRF, password resets, visitor passes).

Tokens are 256-bit `secrets.token_urlsafe` values. Only their SHA-256 hex digest is stored; lookups go
by the unique hash. Raw tokens are never logged or persisted.
"""

import hashlib
import hmac
import re
import secrets
from urllib.parse import quote

TOKEN_BYTES = 32
# Alphabet/length accepted from clients (contract §6); anything else is rejected before hashing.
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,128}")

# Scanner/paste input grammar shared with the frontend parser (frontend/src/scanner/parsePassToken.ts);
# both run the cases in docs/contract/pass-token-vectors.json. A plain pattern on purpose: URL parsers
# normalise dot segments, backslashes and embedded tabs, so two parsers would disagree on what a valid
# pass URL is. http(s) only (scheme case-insensitive), any host and port, no user info, the path exactly
# /pass or /pass/, an optional query, and the token as the whole fragment. The query is where a pass link
# names its company (`?c=<slug>`, B12-14); the grammar accepts any query and none, so the links of
# every release parse, and it never reads the query: only the token decides.
PASS_URL_PATTERN = re.compile(
    r"[Hh][Tt][Tt][Pp][Ss]?://[^/?#@\\]+/pass/?(?:\?[^#]*)?#([A-Za-z0-9_-]{32,128})", re.ASCII
)
# Spaces and ASCII control characters never occur in a pass URL.
_SPACE_OR_CONTROL = re.compile(r"[\x00-\x20\x7f]")
# The characters ECMAScript's String.prototype.trim() removes (WhiteSpace and LineTerminator), so both
# parsers trim identically. Python's str.strip() differs: it also strips U+001C-U+001F (e.g. the GS
# separator some handheld scanners append) and U+0085, and keeps U+FEFF.
JS_TRIM_CHARACTERS = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003"
    "\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def generate_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("ascii")).hexdigest()


def is_well_formed(raw: str | None) -> bool:
    return raw is not None and TOKEN_PATTERN.fullmatch(raw) is not None


def token_matches(stored_hash: str, presented: str | None) -> bool:
    """Constant-time comparison of a presented raw token against a stored hash."""
    if presented is None or not is_well_formed(presented):
        return False
    return hmac.compare_digest(stored_hash, hash_token(presented))


def build_pass_url(pass_url_base: str, token: str, company_slug: str | None = None) -> str:
    """`{QR_BASE_URL}/pass?c=<slug>#<token>`: the token travels in the fragment, which browsers never
    send to a server; the query names the company (its public slug, percent-encoded), so the pass page can
    show that company's identity (B12-14). Without a slug: `{QR_BASE_URL}/pass#<token>`, the form of
    every earlier link, which still works. `pass_url_base` is `Settings.pass_url_base`."""
    query = f"?c={quote(company_slug, safe='')}" if company_slug else ""
    return f"{pass_url_base}{query}#{token}"


def extract_pass_token(value: str | None) -> str | None:
    """Parse scanner/paste input: a bare token or a pass URL (`http(s)://host/pass#<token>`).

    Returns the token, or None for anything else. Pure and side-effect free.
    """
    if value is None:
        return None
    candidate = value.strip(JS_TRIM_CHARACTERS)
    if is_well_formed(candidate):
        return candidate
    if _SPACE_OR_CONTROL.search(candidate):
        return None
    match = PASS_URL_PATTERN.fullmatch(candidate)
    return match.group(1) if match else None
