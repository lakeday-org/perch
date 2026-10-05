"""The response headers that tell a client its limit, as the IETF RateLimit draft and Retry-After spell them."""
import math
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Dict, Optional

from .algorithms.base import Decision


def format_seconds(seconds: float) -> str:
    """Whole seconds, rounded up, and at least 1 while anything is left to wait."""
    if seconds <= 0:
        return "0"
    return str(max(math.ceil(seconds), 1))


def rate_limit_headers(decision: Decision, policy: Optional[str] = None) -> Dict[str, str]:
    headers = {
        "RateLimit-Limit": str(decision.limit),
        "RateLimit-Remaining": str(max(decision.remaining, 0)),
        "RateLimit-Reset": format_seconds(decision.reset_after),
    }
    if policy:
        headers["RateLimit-Policy"] = policy
    if not decision.allowed:
        headers["Retry-After"] = format_seconds(decision.retry_after)
    return headers


def parse_retry_after(value: str, now: Optional[datetime] = None) -> float:
    """Seconds to wait, from a Retry-After of either delay-seconds or an HTTP date."""
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        raise ValueError(f"Retry-After {value!r} is neither seconds nor an HTTP date") from None
    now = now or datetime.now(timezone.utc)
    return max((when - now).total_seconds(), 0.0)
