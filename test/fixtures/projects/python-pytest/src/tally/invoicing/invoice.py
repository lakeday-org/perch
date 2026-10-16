"""Invoices: line items, tax, issuing, payments, and the journal entry an invoice posts."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from .._compat import UTC
from ..errors import CurrencyMismatch, TallyError
from ..journal import Entry
from ..money import Money
from .numbering import InvoiceNumberer
from .tax import DEFAULT_TABLE, tax_by_code
from .terms import due_date


@dataclass
class LineItem:
    description: str
    quantity: Decimal
    unit_price: Money
    discount: Decimal = Decimal(0)
    tax_code: str | None = "standard"

    def net(self) -> Money:
        if not Decimal(0) <= self.discount <= Decimal(100):
            raise ValueError(f"discount {self.discount}% is outside 0-100")
        gross = self.unit_price * self.quantity
        return (gross - gross * (self.discount / Decimal(100))).rounded()


class Invoice:
    def __init__(self, customer: str, currency: str = "USD", *, terms: str = "net30", tax_table=DEFAULT_TABLE) -> None:
        self.customer = customer
        self.currency = currency.upper()
        self.terms = terms
        self.tax_table = tax_table
        self.items: list[LineItem] = []
        self.payments: list[tuple[date, Money]] = []
        self.number: str | None = None
        self.issued: date | None = None
        self.due: date | None = None

    def add(self, description: str, quantity: Decimal | int, unit_price: Money, **options) -> LineItem:
        if self.number is not None:
            raise TallyError(f"invoice {self.number} is issued and cannot change")
        if unit_price.currency != self.currency:
            raise CurrencyMismatch(self.currency, unit_price.currency)
        item = LineItem(description, Decimal(quantity), unit_price, **options)
        self.items.append(item)
        return item

    def subtotal(self) -> Money:
        total = Money.zero(self.currency)
        for item in self.items:
            total = total + item.net()
        return total

    def taxes(self) -> dict[str, Money]:
        return tax_by_code(((item.net(), item.tax_code) for item in self.items), self.tax_table)

    def total(self) -> Money:
        total = self.subtotal()
        for amount in self.taxes().values():
            total = total + amount
        return total

    def issue(self, numberer: InvoiceNumberer, on: date) -> str:
        if self.number is not None:
            raise TallyError(f"invoice {self.number} is already issued")
        if not self.items:
            raise TallyError("an invoice with no items cannot be issued")
        self.number = numberer.next(on)
        self.issued = on
        self.due = due_date(on, self.terms)
        return self.number

    def paid(self) -> Money:
        total = Money.zero(self.currency)
        for _, amount in self.payments:
            total = total + amount
        return total

    def balance_due(self) -> Money:
        return self.total() - self.paid()

    def record_payment(self, amount: Money, on: date) -> Money:
        """Records a payment and returns what is still owed."""
        if self.number is None:
            raise TallyError("record payments against an issued invoice")
        if amount.amount <= 0:
            raise ValueError("a payment is a positive amount")
        if amount.amount > self.balance_due().amount:
            raise ValueError(f"{amount} is more than the {self.balance_due()} owed")
        self.payments.append((on, amount))
        return self.balance_due()

    def to_entry(self, *, receivable: str = "1200", revenue: str = "4000", tax_payable: str = "2200") -> Entry:
        """The sale as a journal entry: receivable debited, revenue and tax credited."""
        entry = Entry(self.issued or datetime.now(UTC).date(), memo=f"Invoice {self.number or '(draft)'} to {self.customer}")
        entry.debit(receivable, self.total())
        entry.credit(revenue, self.subtotal())
        tax = Money.zero(self.currency)
        for amount in self.taxes().values():
            tax = tax + amount
        if not tax.is_zero():
            entry.credit(tax_payable, tax)
        return entry
