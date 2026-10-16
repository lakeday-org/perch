"""Invoice numbers: a prefix, the year, and a sequence that restarts every year."""
from __future__ import annotations

from datetime import date


class InvoiceNumberer:
    def __init__(self, prefix: str = "INV", width: int = 4, *, per_year: bool = True) -> None:
        if width < 1:
            raise ValueError("width must be at least 1")
        self.prefix = prefix
        self.width = width
        self.per_year = per_year
        self._counters: dict[int, int] = {}

    def _key(self, on: date) -> int:
        return on.year if self.per_year else 0

    def peek(self, on: date) -> str:
        return self._format(on, self._counters.get(self._key(on), 0) + 1)

    def next(self, on: date) -> str:
        key = self._key(on)
        self._counters[key] = self._counters.get(key, 0) + 1
        return self._format(on, self._counters[key])

    def _format(self, on: date, sequence: int) -> str:
        number = str(sequence).zfill(self.width)
        if self.per_year:
            return f"{self.prefix}-{on.year}-{number}"
        return f"{self.prefix}-{number}"

    def restore(self, issued: list[str]) -> None:
        """Carries the counters on from numbers already issued, as after loading saved invoices."""
        for number in issued:
            parts = number.split("-")
            key = int(parts[1]) if self.per_year else 0
            self._counters[key] = max(self._counters.get(key, 0), int(parts[-1]))
