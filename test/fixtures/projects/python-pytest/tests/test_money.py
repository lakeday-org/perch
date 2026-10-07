from decimal import ROUND_HALF_UP, Decimal

import pytest

from tally import CurrencyMismatch, Money
from tally.money import minor_units


def usd(amount: str) -> Money:
    return Money(Decimal(amount), "USD")


def test_add_and_subtract_in_one_currency():
    assert usd("10.25") + usd("4.75") == usd("15.00")
    assert usd("10.25") - usd("0.25") == usd("10.00")


def test_adding_another_currency_raises():
    with pytest.raises(CurrencyMismatch) as caught:
        usd("1") + Money("1", "EUR")
    assert caught.value.right == "EUR"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("12.50 USD", Money(Decimal("12.50"), "USD")),
        ("EUR 3", Money(Decimal("3"), "EUR")),
        ("$1,204.99", Money(Decimal("1204.99"), "USD")),
        ("¥1200", Money(Decimal("1200"), "JPY")),
    ],
)
def test_parse(text, expected):
    assert Money.parse(text) == expected


@pytest.mark.parametrize("text", ["twelve dollars", "12.50", "USD 3 EUR"])
def test_parse_rejects(text):
    with pytest.raises(ValueError):
        Money.parse(text)


@pytest.mark.parametrize(
    ("amount", "currency", "rounding", "expected"),
    [
        ("2.345", "USD", None, "2.34"),
        ("2.355", "USD", None, "2.36"),
        ("2.345", "USD", ROUND_HALF_UP, "2.35"),
        ("1234.5", "JPY", None, "1234"),
        ("1.0005", "KWD", ROUND_HALF_UP, "1.001"),
    ],
)
def test_rounded(amount, currency, rounding, expected):
    money = Money(Decimal(amount), currency)
    result = money.rounded() if rounding is None else money.rounded(rounding)
    assert result.amount == Decimal(expected)


def test_allocate_gives_leftover_cents_to_the_first_parts():
    parts = usd("100.00").allocate([1, 1, 1])
    assert [part.amount for part in parts] == [Decimal("33.34"), Decimal("33.33"), Decimal("33.33")]
    assert sum((part.amount for part in parts), Decimal(0)) == Decimal("100.00")


def test_allocate_rejects_all_zero_ratios():
    with pytest.raises(ValueError):
        usd("10").allocate([0, 0])


def test_minor_units_of_an_unknown_currency():
    with pytest.raises(ValueError, match="XYZ"):
        minor_units("XYZ")


def test_str():
    assert str(Money(Decimal("1234.5"), "usd")) == "1,234.50 USD"
