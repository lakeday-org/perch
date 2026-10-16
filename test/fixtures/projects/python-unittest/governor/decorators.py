"""Limiting a function: `@limit(limiter, key=...)`."""
import functools
from typing import Callable

from .algorithms.base import Limiter


def _global(*args, **kwargs) -> str:
    return "global"


def limit(limiter: Limiter, key: Callable[..., str] = _global, *, block: bool = False, max_wait: float = 30.0):
    """Counts each call against `limiter` under `key(*args, **kwargs)`. Refused calls raise, or with `block`, wait their turn."""

    def decorate(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            name = key(*args, **kwargs)
            if not block:
                limiter.check(name)
                return func(*args, **kwargs)
            waited = 0.0
            while True:
                decision = limiter.hit(name)
                if decision.allowed:
                    return func(*args, **kwargs)
                if waited + decision.retry_after > max_wait:
                    limiter.check(name)
                limiter.clock.sleep(decision.retry_after)
                waited += decision.retry_after

        wrapper.limiter = limiter
        return wrapper

    return decorate
