"""Journal entries: dated lists of debits and credits that must balance."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from .errors import CurrencyMismatch, UnbalancedEntry
from .money import Money


@dataclass(frozen=True)
class Line:
    account: str
    debit: Money | None = None
    credit: Money | None = None

    def __post_init__(self) -> None:
        if (self.debit is None) == (self.credit is None):
            raise ValueError("a line is a debit or a credit, not both or neither")
        if self.amount.amount <= 0:
            raise ValueError("line amounts are positive; use the other side instead")

    @property
    def amount(self) -> Money:
        return self.debit if self.debit is not None else self.credit

    @property
    def side(self) -> str:
        return "debit" if self.debit is not None else "credit"


@dataclass
class Entry:
    date: date
    memo: str = ""
    lines: list[Line] = field(default_factory=list)

    def debit(self, account: str, amount: Money) -> Entry:
        self.lines.append(Line(account, debit=amount))
        return self

    def credit(self, account: str, amount: Money) -> Entry:
        self.lines.append(Line(account, credit=amount))
        return self

    def currency(self) -> str:
        currencies = {line.amount.currency for line in self.lines}
        if len(currencies) > 1:
            first, second = sorted(currencies)[:2]
            raise CurrencyMismatch(first, second)
        return currencies.pop() if currencies else "USD"

    def totals(self) -> tuple[Money, Money]:
        currency = self.currency()
        debits = credits = Money.zero(currency)
        for line in self.lines:
            if line.side == "debit":
                debits = debits + line.amount
            else:
                credits = credits + line.amount
        return debits, credits

    def is_balanced(self) -> bool:
        debits, credits = self.totals()
        return debits == credits

    def validate(self) -> None:
        if len(self.lines) < 2:
            raise UnbalancedEntry("an entry needs at least two lines")
        debits, credits = self.totals()
        if debits != credits:
            raise UnbalancedEntry(f"debits {debits} do not equal credits {credits}")
