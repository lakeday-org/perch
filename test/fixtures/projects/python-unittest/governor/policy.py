"""Rates as people write them: `100/minute`, `10 per second`, `1000/6 hours`."""
import re
from dataclasses import dataclass
from typing import List

UNITS = {"second": 1, "minute": 60, "hour": 3600, "day": 86400}
_RATE = re.compile(r"^\s*(\d+)\s*(?:/|per)\s*(\d+)?\s*(second|minute|hour|day)s?\s*$", re.IGNORECASE)
_ABBREVIATIONS = {"s": "second", "sec": "second", "m": "minute", "min": "minute", "h": "hour", "hr": "hour", "d": "day"}


@dataclass(frozen=True)
class Rate:
    limit: int
    period: float

    def __post_init__(self) -> None:
        if self.limit < 1:
            raise ValueError("a rate allows at least one request")
        if self.period <= 0:
            raise ValueError("a rate's period is a positive number of seconds")

    @property
    def per_second(self) -> float:
        return self.limit / self.period

    def __str__(self) -> str:
        for unit, seconds in sorted(UNITS.items(), key=lambda item: -item[1]):
            if self.period % seconds == 0:
                count = int(self.period // seconds)
                return f"{self.limit}/{unit}" if count == 1 else f"{self.limit}/{count} {unit}s"
        return f"{self.limit}/{self.period:g}s"


def _expand(text: str) -> str:
    head, _, unit = text.rpartition(" ") if " " in text.strip() else text.rpartition("/")
    unit = unit.strip().lower()
    if unit in _ABBREVIATIONS:
        separator = " " if " " in text.strip() else "/"
        return f"{head}{separator}{_ABBREVIATIONS[unit]}"
    return text


def parse_rate(text: str) -> Rate:
    match = _RATE.match(_expand(text))
    if not match:
        raise ValueError(f"cannot read {text!r} as a rate; write it like 100/minute")
    limit, count, unit = int(match[1]), int(match[2] or 1), match[3].lower()
    return Rate(limit, count * UNITS[unit])


def parse_policy(text: str) -> List[Rate]:
    """Several rates at once, `10/second; 500/hour`, shortest period first, duplicates dropped."""
    rates = []
    for part in re.split(r"[;,]", text):
        if not part.strip():
            continue
        rate = parse_rate(part)
        if rate not in rates:
            rates.append(rate)
    if not rates:
        raise ValueError("a policy needs at least one rate")
    return sorted(rates, key=lambda rate: (rate.period, rate.limit))
