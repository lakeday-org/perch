"""Two fixed windows, the previous one weighted by how much of it still overlaps the last period."""
import math

from .base import Decision, Limiter


class SlidingWindowCounter(Limiter):
    name = "sliding-window"

    def _counts(self, key: str, now: float):
        period = self.rate.period
        start = math.floor(now / period) * period
        current = self.storage.get(f"{self.key_for(key)}:{start:.0f}", 0)
        previous = self.storage.get(f"{self.key_for(key)}:{start - period:.0f}", 0)
        overlap = 1 - (now - start) / period
        return start, current, previous * overlap

    def hit(self, key: str, cost: int = 1) -> Decision:
        now = self.clock.now()
        start, current, weighted = self._counts(key, now)
        used = current + weighted
        if used + cost > self.rate.limit:
            retry = self.rate.period * (used + cost - self.rate.limit) / max(weighted, 1) if weighted else start + self.rate.period - now
            return Decision(False, self.rate.limit, max(int(self.rate.limit - used), 0), start + self.rate.period - now, min(retry, self.rate.period))
        self.storage.incr(f"{self.key_for(key)}:{start:.0f}", cost, ttl=2 * self.rate.period)
        return Decision(True, self.rate.limit, int(self.rate.limit - used - cost), start + self.rate.period - now)

    def peek(self, key: str) -> Decision:
        now = self.clock.now()
        start, current, weighted = self._counts(key, now)
        used = current + weighted
        return Decision(used < self.rate.limit, self.rate.limit, max(int(self.rate.limit - used), 0), start + self.rate.period - now)
