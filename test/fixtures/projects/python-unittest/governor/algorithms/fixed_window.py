"""A counter per calendar window: simple and cheap, and allows up to twice the rate across a window edge."""
import math

from .base import Decision, Limiter


class FixedWindow(Limiter):
    name = "fixed-window"

    def _window(self, now: float):
        start = math.floor(now / self.rate.period) * self.rate.period
        return start, start + self.rate.period

    def hit(self, key: str, cost: int = 1) -> Decision:
        now = self.clock.now()
        start, end = self._window(now)
        count = self.storage.incr(f"{self.key_for(key)}:{start:.0f}", cost, ttl=end - now)
        allowed = count <= self.rate.limit
        if not allowed:
            # A refused hit takes nothing, so a client that keeps retrying is not locked out of the next window too.
            self.storage.incr(f"{self.key_for(key)}:{start:.0f}", -cost)
        remaining = max(self.rate.limit - (count if allowed else count - cost), 0)
        return Decision(allowed, self.rate.limit, remaining, end - now, 0.0 if allowed else end - now)

    def peek(self, key: str) -> Decision:
        now = self.clock.now()
        start, end = self._window(now)
        count = self.storage.get(f"{self.key_for(key)}:{start:.0f}", 0)
        return Decision(count < self.rate.limit, self.rate.limit, max(self.rate.limit - count, 0), end - now)
