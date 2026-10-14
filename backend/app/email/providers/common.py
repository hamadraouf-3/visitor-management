import re

# Content IDs of inline images: they become file names (outbox) and `Content-ID` header values (SMTP).
SAFE_CONTENT_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")


def recipient_domain_matches(address: str, domain: str) -> bool:
    """True when `address` is at `domain` or one of its subdomains."""
    recipient_domain = address.rpartition("@")[2].lower()
    domain = domain.lower()
    return recipient_domain == domain or recipient_domain.endswith("." + domain)
