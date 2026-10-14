"""Client IP derivation (contract §7.3).

If the direct peer is a trusted proxy, the client is the rightmost `X-Forwarded-For` entry that is not
itself a trusted proxy; otherwise it is the peer address. Every address is parsed with `ipaddress`;
anything unparsable yields None (stored as NULL) rather than a guess. Entries left of an unparsable
entry are never used because they cannot be attributed to a trusted hop. Scoped IPv6 addresses
(`fe80::1%eth0`) count as unparsable: a zone ID only means something on the host that received the
packet, and PostgreSQL `inet` cannot store it.
"""

from collections.abc import Iterable, Mapping, Sequence
from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network, ip_address, ip_network
from typing import Any

type IPAddress = IPv4Address | IPv6Address
type IPNetwork = IPv4Network | IPv6Network

# An IPv6 end site normally controls at least a whole /64 (RFC 6177), i.e. 2^64 source addresses.
IPV6_SUBJECT_PREFIX = 64
# ... and is commonly assigned a /48 (65,536 /64s): the coarse secondary limits key on it.
IPV6_SITE_PREFIX = 48
UNKNOWN_SUBJECT = "unknown"


def parse_ip(value: str | None) -> IPAddress | None:
    if not value:
        return None
    try:
        parsed = ip_address(value.strip())
    except ValueError:
        return None
    if isinstance(parsed, IPv6Address):
        if parsed.scope_id is not None:
            return None
        if parsed.ipv4_mapped is not None:
            return parsed.ipv4_mapped
    return parsed


def _is_trusted(address: IPAddress, trusted: Sequence[IPNetwork]) -> bool:
    return any(address.version == network.version and address in network for network in trusted)


def derive_client_ip(
    peer: str | None,
    forwarded_for: Iterable[str],
    trusted_proxies: Sequence[IPNetwork],
) -> str | None:
    """Pure implementation, independent of the web framework.

    `forwarded_for` holds the raw values of every `X-Forwarded-For` header in arrival order.
    """
    peer_ip = parse_ip(peer)
    if peer_ip is None:
        return None
    if not trusted_proxies or not _is_trusted(peer_ip, trusted_proxies):
        return str(peer_ip)

    entries = [entry.strip() for header in forwarded_for for entry in header.split(",")]
    entries = [entry for entry in entries if entry]
    if not entries:
        return None
    candidate: IPAddress | None = None
    for raw in reversed(entries):
        parsed = parse_ip(raw)
        if parsed is None:
            return None
        candidate = parsed
        if not _is_trusted(parsed, trusted_proxies):
            return str(parsed)
    # Every hop is inside the trusted ranges: the leftmost one is the furthest known client.
    return str(candidate) if candidate is not None else None


def rate_limit_subject(ip: str | None) -> str:
    """The client a per-IP limit applies to.

    IPv4: the address. IPv6: its /64 network, because one client can rotate through every address of
    its prefix and would otherwise get a fresh budget per address. Unknown address: one shared subject.
    Audit rows and sessions keep the full address; this is only for throttling.
    """
    parsed = parse_ip(ip)
    if parsed is None:
        return UNKNOWN_SUBJECT
    if isinstance(parsed, IPv6Address):
        return str(ip_network(f"{parsed}/{IPV6_SUBJECT_PREFIX}", strict=False))
    return str(parsed)


def rate_limit_prefix(ip: str | None) -> str | None:
    """The network a coarse secondary per-prefix limit applies to: the client's IPv6 /48.

    None for IPv4 and unknown addresses, whose per-IP subject already covers the whole client.
    """
    parsed = parse_ip(ip)
    if not isinstance(parsed, IPv6Address):
        return None
    return str(ip_network(f"{parsed}/{IPV6_SITE_PREFIX}", strict=False))


def peer_is_trusted_proxy(scope: Mapping[str, Any], trusted_proxies: Sequence[IPNetwork]) -> bool:
    """Whether the direct peer of an ASGI HTTP scope is one of the trusted proxies: only such a hop may
    vouch for request metadata (`X-Forwarded-For`, `X-Request-ID`)."""
    client = scope.get("client")
    peer = parse_ip(client[0] if client else None)
    return peer is not None and _is_trusted(peer, trusted_proxies)


def client_ip_from_scope(scope: Mapping[str, Any], trusted_proxies: Sequence[IPNetwork]) -> str | None:
    """Derive the client IP from an ASGI HTTP scope."""
    client = scope.get("client")
    peer = client[0] if client else None
    forwarded = [
        value.decode("latin-1") for name, value in scope.get("headers", []) if name == b"x-forwarded-for"
    ]
    return derive_client_ip(peer, forwarded, trusted_proxies)
