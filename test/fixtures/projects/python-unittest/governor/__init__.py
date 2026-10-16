"""Rate limiting for Python services."""
from .algorithms import FixedWindow, SlidingWindowCounter, TokenBucket
from .algorithms.base import Decision, Limiter
from .decorators import limit
from .errors import RateLimitExceeded
from .policy import Rate, parse_policy, parse_rate
from .storage.memory import MemoryStorage

__version__ = "1.3.0"

__all__ = [
    "Decision",
    "FixedWindow",
    "Limiter",
    "MemoryStorage",
    "Rate",
    "RateLimitExceeded",
    "SlidingWindowCounter",
    "TokenBucket",
    "limit",
    "parse_policy",
    "parse_rate",
]
