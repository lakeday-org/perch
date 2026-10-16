"""What every limiter does: decide on a hit, and say how long until the next one would be allowed."""
from dataclasses import dataclass
from typing import Optional, Union

from ..clock import Clock, SystemClock
from ..errors import RateLimitExceeded
from ..policy import Rate, parse_rate
from ..storage.memory import MemoryStorage


@dataclass(frozen=True)
class Decision:
    allowed: bool
    limit: int
    remaining: int
    reset_after: float
    retry_after: float = 0.0


class Limiter:
    name = "limiter"

    def __init__(self, rate: Union[str, Rate], *, storage=None, clock: Optional[Clock] = None, prefix: str = "governor") -> None:
        self.rate = parse_rate(rate) if isinstance(rate, str) else rate
        self.clock = clock or SystemClock()
        self.storage = storage if storage is not None else MemoryStorage(self.clock)
        self.prefix = prefix

    def key_for(self, key: str) -> str:
        return f"{self.prefix}:{self.name}:{self.rate.limit}/{self.rate.period:g}:{key}"

    def hit(self, key: str, cost: int = 1) -> Decision:
        raise NotImplementedError

    def peek(self, key: str) -> Decision:
        raise NotImplementedError

    def check(self, key: str, cost: int = 1) -> Decision:
        """Like `hit`, but raises RateLimitExceeded instead of returning a refusal."""
        decision = self.hit(key, cost)
        if not decision.allowed:
            raise RateLimitExceeded(key, str(self.rate), decision.retry_after)
        return decision

    def reset(self, key: str) -> None:
        self.storage.delete(self.key_for(key))
