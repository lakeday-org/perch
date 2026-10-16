"""A bucket of `burst` tokens refilled at the rate; each hit takes `cost` tokens or is refused."""
from typing import Tuple

from .base import Decision, Limiter


class TokenBucket(Limiter):
    name = "token-bucket"

    def __init__(self, rate, burst: int = 0, **options) -> None:
        super().__init__(rate, **options)
        self.burst = burst or self.rate.limit
        if self.burst < 1:
            raise ValueError("burst must be at least 1")

    def _refill(self, key: str, now: float) -> Tuple[float, float]:
        tokens, updated = self.storage.get(self.key_for(key), (float(self.burst), now))
        tokens = min(float(self.burst), tokens + (now - updated) * self.rate.per_second)
        return tokens, now

    def _decision(self, tokens: float, allowed: bool, cost: int) -> Decision:
        per_second = self.rate.per_second
        missing = 0.0 if allowed else cost - tokens
        return Decision(allowed, self.burst, int(tokens), (self.burst - tokens) / per_second, missing / per_second)

    def hit(self, key: str, cost: int = 1) -> Decision:
        if cost > self.burst:
            raise ValueError(f"a cost of {cost} can never fit a bucket of {self.burst}")
        now = self.clock.now()
        tokens, _ = self._refill(key, now)
        allowed = tokens >= cost
        if allowed:
            tokens -= cost
        self.storage.set(self.key_for(key), (tokens, now), ttl=self.burst / self.rate.per_second)
        return self._decision(tokens, allowed, cost)

    def peek(self, key: str) -> Decision:
        tokens, _ = self._refill(key, self.clock.now())
        return self._decision(tokens, tokens >= 1, 1)
