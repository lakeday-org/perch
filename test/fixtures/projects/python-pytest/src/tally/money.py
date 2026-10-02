"""Amounts of money in one currency, kept as Decimal and rounded to the currency's minor unit."""
from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Iterable

from .errors import CurrencyMismatch

_MINOR_UNITS = {"USD": 2, "EUR": 2, "GBP": 2, "CAD": 2, "JPY": 0, "KWD": 3}
_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY"}
_PATTERN = re.compile(r"^\s*(?:(?P<pre>[A-Z]{3})\s+)?(?P<sym>[$€£¥])?(?P<num>-?[\d,]*\.?\d+)\s*(?P<post>[A-Z]{3})?\s*$")


def minor_units(currency: str) -> int:
    """Digits after the decimal point in the currency's smallest unit."""
    try:
        return _MINOR_UNITS[currency]
    except KeyError:
        raise ValueError(f"unknown currency {currency!r}") from None


@dataclass(frozen=True)
class Money:
    amount: Decimal
    currency: str

    def __post_init__(self) -> None:
        if not isinstance(self.amount, Decimal):
            object.__setattr__(self, "amount", Decimal(str(self.amount)))
        object.__setattr__(self, "currency", self.currency.upper())

    @classmethod
    def zero(cls, currency: str) -> Money:
        return cls(Decimal(0), currency)

    @classmethod
    def parse(cls, text: str) -> Money:
        """`12.50 USD`, `USD 12.50`, `$12.50` or `¥1,200`."""
        match = _PATTERN.match(text)
        if not match:
            raise ValueError(f"not an amount of money: {text!r}")
        currency = match["pre"] or match["post"] or _SYMBOLS.get(match["sym"] or "")
        if not currency:
            raise ValueError(f"no currency in {text!r}")
        if match["pre"] and match["post"] and match["pre"] != match["post"]:
            raise ValueError(f"two currencies in {text!r}")
        return cls(Decimal(match["num"].replace(",", "")), currency)

    def _check(self, other: Money) -> None:
        if not isinstance(other, Money):
            raise TypeError(f"expected Money, got {type(other).__name__}")
        if other.currency != self.currency:
            raise CurrencyMismatch(self.currency, other.currency)

    def __add__(self, other: Money) -> Money:
        self._check(other)
        return Money(self.amount + other.amount, self.currency)

    def __sub__(self, other: Money) -> Money:
        self._check(other)
        return Money(self.amount - other.amount, self.currency)

    def __neg__(self) -> Money:
        return Money(-self.amount, self.currency)

    def __mul__(self, factor: Decimal | int) -> Money:
        if isinstance(factor, float):
            raise TypeError("multiply money by Decimal or int, not float")
        return Money(self.amount * factor, self.currency)

    __rmul__ = __mul__

    def is_zero(self) -> bool:
        return self.amount == 0

    def rounded(self, rounding: str = ROUND_HALF_EVEN) -> Money:
        quantum = Decimal(1).scaleb(-minor_units(self.currency))
        return Money(self.amount.quantize(quantum, rounding=rounding), self.currency)

    def allocate(self, ratios: Iterable[int]) -> list[Money]:
        """Split into parts in proportion to `ratios`, the leftover minor units going to the first parts."""
        ratios = list(ratios)
        if not ratios or any(ratio < 0 for ratio in ratios) or sum(ratios) == 0:
            raise ValueError("ratios must be non-negative and not all zero")
        unit = Decimal(1).scaleb(-minor_units(self.currency))
        total = sum(ratios)
        parts = [(self.amount * ratio / total).quantize(unit, rounding="ROUND_FLOOR") for ratio in ratios]
        remainder = self.amount - sum(parts)
        index = 0
        while remainder >= unit:
            parts[index % len(parts)] += unit
            remainder -= unit
            index += 1
        return [Money(part, self.currency) for part in parts]

    def __str__(self) -> str:
        places = minor_units(self.currency)
        return f"{self.amount:,.{places}f} {self.currency}"
