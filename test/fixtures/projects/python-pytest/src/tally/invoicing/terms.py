"""Payment terms, due dates and late fees."""
from __future__ import annotations

import calendar
import re
from datetime import date, timedelta
from decimal import Decimal

from ..money import Money

_NET = re.compile(r"^net\s*(\d{1,3})$")


def parse_terms(terms: str) -> tuple[str, int]:
    """`net30` and `net 30` are ("net", 30); `eom` and `due_on_receipt` take no days."""
    text = terms.strip().lower().replace("-", "_")
    if text in ("due_on_receipt", "cod"):
        return ("receipt", 0)
    if text == "eom":
        return ("eom", 0)
    match = _NET.match(text)
    if match:
        return ("net", int(match[1]))
    raise ValueError(f"unknown payment terms {terms!r}")


def due_date(issued: date, terms: str) -> date:
    kind, days = parse_terms(terms)
    if kind == "net":
        return issued + timedelta(days=days)
    if kind == "eom":
        last = calendar.monthrange(issued.year, issued.month)[1]
        return issued.replace(day=last)
    return issued


def days_overdue(due: date, today: date) -> int:
    return max((today - due).days, 0)


def late_fee(balance: Money, days: int, *, monthly_rate: Decimal = Decimal("0.015"), minimum: Decimal = Decimal("5")) -> Money:
    """Interest at `monthly_rate` per 30 days late, never less than `minimum` once late at all."""
    if days <= 0 or balance.amount <= 0:
        return Money.zero(balance.currency)
    interest = balance * (monthly_rate * Decimal(days) / Decimal(30))
    floor = Money(minimum, balance.currency)
    return (interest if interest.amount > minimum else floor).rounded()
