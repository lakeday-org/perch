from decimal import Decimal

import pytest

from tally import Money
from tally.invoicing import TaxRule
from tally.invoicing.tax import tax_by_code, tax_for


@pytest.mark.parametrize(
    ("code", "expected"),
    [("standard", "8.25"), ("reduced", "4.00"), ("exempt", "0"), (None, "0"), ("qc", "14.98")],
)
def test_tax_for(code, expected):
    assert tax_for(Money("100.00", "USD"), code).rounded().amount == Decimal(expected)


def test_compound_rule_is_charged_on_tax_too():
    table = {"x": (TaxRule("a", Decimal("0.10")), TaxRule("b", Decimal("0.10"), compound=True))}
    assert tax_for(Money("100", "USD"), "x", table) == Money("21", "USD")


def test_unknown_code_raises():
    with pytest.raises(ValueError, match="no tax code"):
        tax_for(Money("1", "USD"), "luxury")


def test_tax_by_code_rounds_once_per_code():
    lines = [(Money("0.10", "USD"), "standard")] * 3 + [(Money("5", "USD"), None)]
    assert tax_by_code(lines) == {"standard": Money("0.02", "USD")}


def test_rate_must_be_a_fraction():
    with pytest.raises(ValueError):
        TaxRule("bad", Decimal("8.25"))
