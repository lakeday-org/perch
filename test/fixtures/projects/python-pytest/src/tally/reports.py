"""Receivables aging: what customers owe, by how late it is."""
from __future__ import annotations

from datetime import date

from .invoicing.invoice import Invoice
from .invoicing.terms import days_overdue
from .money import Money

BUCKETS = ((0, "current"), (30, "1-30"), (60, "31-60"), (90, "61-90"))


def aging_bucket(days: int) -> str:
    for limit, name in BUCKETS:
        if days <= limit:
            return name
    return "90+"


def aging_report(invoices: list[Invoice], today: date, currency: str = "USD") -> dict[str, Money]:
    report = {name: Money.zero(currency) for _, name in BUCKETS}
    report["90+"] = Money.zero(currency)
    for invoice in invoices:
        if invoice.due is None:
            continue
        owed = invoice.balance_due()
        if owed.is_zero():
            continue
        bucket = aging_bucket(days_overdue(invoice.due, today))
        report[bucket] = report[bucket] + owed
    return report
