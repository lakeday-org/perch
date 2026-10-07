from datetime import date
from decimal import Decimal

import pytest

import tally
from tally import Money
from tally.invoicing.terms import days_overdue, late_fee, parse_terms


@pytest.mark.parametrize(
    ("terms", "issued", "due"),
    [
        ("net30", date(2026, 1, 15), date(2026, 2, 14)),
        ("Net 15", date(2026, 12, 20), date(2027, 1, 4)),
        ("EOM", date(2028, 2, 3), date(2028, 2, 29)),
        ("due-on-receipt", date(2026, 5, 5), date(2026, 5, 5)),
    ],
)
def test_due_date(terms, issued, due):
    assert tally.invoicing.terms.due_date(issued, terms) == due


def test_unknown_terms_raise():
    with pytest.raises(ValueError, match="unknown payment terms"):
        parse_terms("whenever")


def test_days_overdue_is_never_negative():
    assert days_overdue(date(2026, 3, 1), date(2026, 2, 1)) == 0
    assert days_overdue(date(2026, 3, 1), date(2026, 3, 11)) == 10


@pytest.mark.parametrize(
    ("balance", "days", "fee"),
    [("1000.00", 0, "0"), ("1000.00", 30, "15.00"), ("100.00", 10, "5.00"), ("0", 45, "0")],
)
def test_late_fee(balance, days, fee):
    assert late_fee(Money(Decimal(balance), "USD"), days).amount == Decimal(fee)


@pytest.mark.xfail(reason="late fees compound monthly in some states; tally charges simple interest", strict=True)
def test_late_fee_compounds_monthly():
    assert late_fee(Money("1000", "USD"), 60) == Money("30.23", "USD")
