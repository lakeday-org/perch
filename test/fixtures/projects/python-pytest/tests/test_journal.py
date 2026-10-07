from datetime import date
from decimal import Decimal

import pytest

from tally import Entry, Line, Money, UnbalancedEntry


def cash_sale(amount: str, *, tax: str = "0") -> Entry:
    """A cash sale with optional sales tax, balanced unless the caller unbalances it."""
    net = Money(Decimal(amount), "USD")
    entry = Entry(date(2026, 3, 2), memo="Counter sale")
    entry.debit("1000", net + Money(Decimal(tax), "USD"))
    entry.credit("4000", net)
    if Decimal(tax):
        entry.credit("2200", Money(Decimal(tax), "USD"))
    return entry


def test_a_balanced_entry_validates():
    entry = cash_sale("100.00", tax="8.25")
    entry.validate()
    assert entry.is_balanced()
    assert entry.totals() == (Money("108.25", "USD"), Money("108.25", "USD"))


def test_an_unbalanced_entry_raises():
    entry = cash_sale("100.00").credit("2200", Money("1.00", "USD"))
    with pytest.raises(UnbalancedEntry, match="do not equal"):
        entry.validate()


def test_an_entry_needs_two_lines():
    entry = Entry(date(2026, 3, 2)).debit("1000", Money("5", "USD"))
    with pytest.raises(UnbalancedEntry):
        entry.validate()


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"debit": Money("1", "USD"), "credit": Money("1", "USD")},
        {"debit": Money("-1", "USD")},
        {"credit": Money("0", "USD")},
    ],
    ids=["neither", "both", "negative", "zero"],
)
def test_line_rejects(kwargs):
    with pytest.raises(ValueError):
        Line("1000", **kwargs)
