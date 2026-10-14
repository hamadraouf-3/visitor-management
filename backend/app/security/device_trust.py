"""Device cookies: browsers that proved they know an account's password keep signing in (SEC-01).

The per-account login budget of contract §7.3 (10 failures in 15 minutes, then a 15-minute block) stops
password guessing, but on its own it is a remote switch: anyone who knows an address could keep that
account blocked for every browser, the receptionist's tablet and every administrator included, at
about one request a minute. Following OWASP's "device cookies" (Slow Down Online Guessing Attacks with
Device Cookies), the block applies to *untrusted* clients only:

* A browser that signs in successfully, or completes a password reset (proof of control of the
  mailbox), receives a signed device cookie for that account: `__Host-vms_device` (HttpOnly, Secure,
  SameSite=Strict, `DEVICE_TRUST_TTL`), or `vms_device` with COOKIE_SECURE=false. One cookie holds up to
  `MAX_DEVICE_ENTRIES` accounts (a shared reception tablet), newest first.
* A login attempt that presents a valid device cookie for the account it names is judged by that
  device's own budget (`login_failures_device`, the same numbers) instead of the account's: failures
  from that browser block that browser only, and the account's block does not keep it out.
* Every other client is judged by the account's budget, exactly as before.

The cookie is signed, not stored: `<user id>.<issued at>.<epoch>.<nonce>.<HMAC>`, keyed by SECRET_KEY (a
new key ends every device's trust). It names a user ID, which the browser already knows (`GET
/auth/me`), and the account's device-trust epoch (`users.device_trust_epoch`), an opaque value that
changes whenever the account's password is changed or reset or the account is deactivated (SEC-30). An
entry is trusted only while its epoch is the account's current one, so those events end the trust of
every browser that signed in before them: a former holder of the password, who may have collected an
entry (and with it a failure budget) in many cookie jars, is back on the account's budget, while the
browser that made the change or completed the reset is issued a fresh entry. Stealing a cookie (it is
HttpOnly) gains a separate failure budget for that account until the next such event, not access.
"""

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

DEVICE_TRUST_TTL = timedelta(days=90)
MAX_DEVICE_ENTRIES = 5
# Longest cookie value read at all: entries are about 100 characters each.
MAX_DEVICE_COOKIE_LENGTH = 1024
_ENTRY_SEPARATOR = "~"
_FIELD_SEPARATOR = "."
# v2: entries carry the account's epoch (SEC-30); v1 entries (four fields) are ignored.
_LABEL = b"vms-device-trust-v2"
_NONCE_BYTES = 12
_MAC_BYTES = 16
# `users.device_trust_epoch` is a PostgreSQL bigint: a new epoch is a random non-negative 63-bit value,
# so it does not repeat an earlier one (a counter would start again from its default after a downgrade
# and a new upgrade, and old entries would match it again).
_EPOCH_BITS = 63


def new_device_trust_epoch() -> int:
    """A fresh `users.device_trust_epoch`: every device entry issued before it stops being trusted."""
    return secrets.randbits(_EPOCH_BITS)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


@dataclass(frozen=True, slots=True)
class _Entry:
    user_id: UUID
    issued_at: int  # unix seconds
    epoch: int  # the account's `device_trust_epoch` when the entry was issued
    nonce: str
    mac: str

    def render(self) -> str:
        return _FIELD_SEPARATOR.join(
            (self.user_id.hex, f"{self.issued_at:x}", f"{self.epoch:x}", self.nonce, self.mac)
        )


class DeviceTrust:
    def __init__(self, secret_key: str, *, ttl: timedelta = DEVICE_TRUST_TTL) -> None:
        self._key = hmac.new(secret_key.encode(), _LABEL, hashlib.sha256).digest()
        self.ttl = ttl

    def _mac(self, user_id: UUID, issued_at: int, epoch: int, nonce: str) -> str:
        message = _FIELD_SEPARATOR.join((user_id.hex, f"{issued_at:x}", f"{epoch:x}", nonce)).encode("ascii")
        return _b64(hmac.new(self._key, message, hashlib.sha256).digest()[:_MAC_BYTES])

    def _entries(self, cookie: str | None, *, now: datetime) -> list[_Entry]:
        """The valid, unexpired entries of a cookie value; anything else is ignored."""
        if not cookie or len(cookie) > MAX_DEVICE_COOKIE_LENGTH:
            return []
        oldest = int((now - self.ttl).timestamp())
        latest = int(now.timestamp()) + 60  # tolerate a little clock difference between instances
        entries: list[_Entry] = []
        for raw in cookie.split(_ENTRY_SEPARATOR)[:MAX_DEVICE_ENTRIES]:
            fields = raw.split(_FIELD_SEPARATOR)
            if len(fields) != 5:
                continue
            user_hex, issued_hex, epoch_hex, nonce, mac = fields
            try:
                user_id = UUID(hex=user_hex)
                issued_at = int(issued_hex, 16)
                epoch = int(epoch_hex, 16)
            except ValueError:
                continue
            if user_id.hex != user_hex or f"{epoch:x}" != epoch_hex or not oldest <= issued_at <= latest:
                continue
            if hmac.compare_digest(mac, self._mac(user_id, issued_at, epoch, nonce)):
                entries.append(_Entry(user_id, issued_at, epoch, nonce, mac))
        return entries

    def device_for(self, cookie: str | None, user_id: UUID, epoch: int, *, now: datetime) -> str | None:
        """The device's key (its nonce) when the cookie trusts this browser for `user_id` at the
        account's current `epoch`, else None."""
        for entry in self._entries(cookie, now=now):
            if entry.user_id == user_id and entry.epoch == epoch:
                return entry.nonce
        return None

    def issue(self, cookie: str | None, user_id: UUID, epoch: int, *, now: datetime) -> str:
        """The cookie value after trusting this browser for `user_id` at the account's current `epoch`:
        a new entry for the user first (replacing any older one), then the other accounts' valid entries,
        at most `MAX_DEVICE_ENTRIES`."""
        issued_at = int(now.timestamp())
        nonce = _b64(secrets.token_bytes(_NONCE_BYTES))
        fresh = _Entry(user_id, issued_at, epoch, nonce, self._mac(user_id, issued_at, epoch, nonce))
        others = [entry for entry in self._entries(cookie, now=now) if entry.user_id != user_id]
        return _ENTRY_SEPARATOR.join(entry.render() for entry in (fresh, *others)[:MAX_DEVICE_ENTRIES])
