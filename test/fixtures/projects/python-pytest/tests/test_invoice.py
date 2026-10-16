from datetime import date
from decimal import Decimal

import pytest

from tally import Invoice, Money, TallyError
from tally.invoicing.invoice import LineItem


def test_subtotal_applies_line_discounts():
    invoice = Invoice("Globex")
    invoice.add("Widgets", 12, Money("19.99", "USD"), discount=Decimal("10"))
    invoice.add("Setup", 1, Money("75.00", "USD"))
    assert invoice.subtotal() == Money("290.89", "USD")


def test_line_item_rejects_a_discount_over_100_percent():
    item = LineItem("Widgets", Decimal(1), Money("10", "USD"), discount=Decimal("120"))
    with pytest.raises(ValueError):
        item.net()


def test_taxes_and_total(consulting_invoice):
    assert consulting_invoice.taxes() == {"standard": Money("123.75", "USD"), "exempt": Money("0.00", "USD")}
    assert consulting_invoice.total() == Money("1854.15", "USD")


def test_issue_numbers_and_dates_the_invoice(consulting_invoice, numberer, jan_15):
    number = consulting_invoice.issue(numberer, jan_15)
    assert number == "INV-2026-0001"
    assert consulting_invoice.due == date(2026, 2, 14)


def test_an_empty_invoice_cannot_be_issued(numberer):
    with pytest.raises(TallyError, match="no items"):
        Invoice("Initech").issue(numberer, date(2026, 1, 2))


def test_an_issued_invoice_cannot_change(consulting_invoice, numberer, jan_15):
    consulting_invoice.issue(numberer, jan_15)
    with pytest.raises(TallyError):
        consulting_invoice.add("Extra", 1, Money("1", "USD"))


def test_partial_payment_leaves_a_balance(consulting_invoice, numberer, jan_15):
    consulting_invoice.issue(numberer, jan_15)
    remaining = consulting_invoice.record_payment(Money("1000.00", "USD"), date(2026, 2, 1))
    assert remaining == Money("854.15", "USD")
    assert consulting_invoice.balance_due() == remaining


def test_overpayment_is_refused(consulting_invoice, numberer, jan_15):
    consulting_invoice.issue(numberer, jan_15)
    with pytest.raises(ValueError, match="more than"):
        consulting_invoice.record_payment(Money("5000", "USD"), jan_15)


def test_to_entry_posts_a_balanced_sale(consulting_invoice, books, numberer, jan_15):
    consulting_invoice.issue(numberer, jan_15)
    entry = consulting_invoice.to_entry()
    assert entry.is_balanced()
    books.post(entry)
    assert books.balance("1200") == Money("1854.15", "USD")
    assert books.balance("2200") == Money("123.75", "USD")
