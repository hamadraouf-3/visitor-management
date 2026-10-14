from ipaddress import ip_network

import pytest

from app.core.client_ip import (
    client_ip_from_scope,
    derive_client_ip,
    parse_ip,
    rate_limit_prefix,
    rate_limit_subject,
)

PROXIES = [ip_network("10.0.0.0/8"), ip_network("::1/128")]


def test_no_trusted_proxies_uses_peer_and_ignores_forwarded_for() -> None:
    assert derive_client_ip("203.0.113.5", ["198.51.100.1"], []) == "203.0.113.5"


def test_spoofed_header_from_untrusted_peer_is_ignored() -> None:
    assert derive_client_ip("203.0.113.5", ["1.2.3.4"], PROXIES) == "203.0.113.5"


def test_trusted_proxy_uses_rightmost_untrusted_entry() -> None:
    # The client prepended a fake entry; the proxy appended the real address.
    assert derive_client_ip("10.0.0.2", ["6.6.6.6, 198.51.100.7"], PROXIES) == "198.51.100.7"


def test_chain_of_trusted_proxies_is_skipped() -> None:
    assert derive_client_ip("10.0.0.2", ["198.51.100.7, 10.1.1.1, 10.2.2.2"], PROXIES) == "198.51.100.7"


def test_multiple_headers_are_combined_in_order() -> None:
    assert derive_client_ip("10.0.0.2", ["6.6.6.6", "198.51.100.8"], PROXIES) == "198.51.100.8"


@pytest.mark.parametrize("header", ["garbage", "198.51.100.7, not-an-ip", "198.51.100.7:4433", "", " , "])
def test_unparsable_entries_yield_none(header: str) -> None:
    assert derive_client_ip("10.0.0.2", [header], PROXIES) is None


def test_missing_header_behind_trusted_proxy_is_none() -> None:
    assert derive_client_ip("10.0.0.2", [], PROXIES) is None


def test_all_hops_trusted_returns_leftmost() -> None:
    assert derive_client_ip("10.0.0.2", ["10.9.9.9, 10.1.1.1"], PROXIES) == "10.9.9.9"


def test_ipv6_and_mapped_ipv4() -> None:
    assert derive_client_ip("2001:db8::1", [], PROXIES) == "2001:db8::1"
    assert derive_client_ip("::ffff:203.0.113.9", [], PROXIES) == "203.0.113.9"
    assert derive_client_ip("::1", ["2001:db8::7"], PROXIES) == "2001:db8::7"


@pytest.mark.parametrize("peer", ["testclient", "", None, "999.1.1.1"])
def test_invalid_peer_is_none(peer: str | None) -> None:
    assert derive_client_ip(peer, [], PROXIES) is None


def test_scope_adapter_reads_all_forwarded_headers() -> None:
    scope = {
        "client": ("10.0.0.2", 1234),
        "headers": [(b"x-forwarded-for", b"6.6.6.6"), (b"x-forwarded-for", b"198.51.100.9")],
    }
    assert client_ip_from_scope(scope, PROXIES) == "198.51.100.9"
    assert client_ip_from_scope({"headers": []}, PROXIES) is None


@pytest.mark.parametrize(
    ("address", "subject"),
    [
        ("203.0.113.9", "203.0.113.9"),
        ("2001:db8:1:2::1", "2001:db8:1:2::/64"),
        ("2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"),
        ("2001:db8:1:3::1", "2001:db8:1:3::/64"),
        ("::ffff:203.0.113.9", "203.0.113.9"),
        (None, "unknown"),
        ("not-an-ip", "unknown"),
    ],
)
def test_rate_limit_subject_groups_ipv6_by_64(address: str | None, subject: str) -> None:
    assert rate_limit_subject(address) == subject


@pytest.mark.parametrize("address", ["fe80::1%eth0", "fe80::1%25eth0", "ff02::1%1", "fe80::abcd%en0"])
def test_scoped_ipv6_addresses_are_not_client_addresses(address: str) -> None:
    # A zone ID only has meaning on the receiving host, and PostgreSQL inet cannot store one.
    assert parse_ip(address) is None
    assert derive_client_ip(address, [], []) is None
    assert derive_client_ip("10.0.0.1", [address], PROXIES) is None  # as an X-Forwarded-For entry
    assert derive_client_ip("10.0.0.1", [f"{address}, 198.51.100.7"], PROXIES) == "198.51.100.7"
    assert rate_limit_subject(address) == "unknown"


def test_scope_with_a_scoped_peer_has_no_client_ip() -> None:
    assert client_ip_from_scope({"client": ("fe80::1%eth0", 50000), "headers": []}, []) is None


@pytest.mark.parametrize(
    ("address", "prefix"),
    [
        ("2001:db8:1:2::1", "2001:db8:1::/48"),
        ("2001:db8:1:ffff::1", "2001:db8:1::/48"),
        ("2001:db8:2::1", "2001:db8:2::/48"),
        ("203.0.113.9", None),  # IPv4: the per-IP subject is already the whole client
        ("::ffff:203.0.113.9", None),
        (None, None),
        ("fe80::1%eth0", None),
    ],
)
def test_rate_limit_prefix_is_the_ipv6_48(address: str | None, prefix: str | None) -> None:
    assert rate_limit_prefix(address) == prefix
