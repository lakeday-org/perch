"""Helpers for testing code that is rate limited: a clock that only moves when told to."""
from .clock import Clock


class FakeClock(Clock):
    def __init__(self, start: float = 1_000_000.0) -> None:
        self._now = float(start)
        self.slept = []

    def now(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("a clock does not go backwards")
        self._now += seconds

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.advance(max(seconds, 0.0))
