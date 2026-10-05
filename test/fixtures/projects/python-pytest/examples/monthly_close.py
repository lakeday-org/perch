"""Invoice a customer, post the sale, take a payment, and close the month."""
from datetime import date
from decimal import Decimal

import tally
from tally.invoicing import InvoiceNumberer


def close_january():
    books = tally.open_ledger()
    numbers = InvoiceNumberer()
    invoice = tally.Invoice("Acme Corp")
    invoice.add("Consulting", Decimal("10"), tally.Money("150.00", "USD"))
    invoice.issue(numbers, date(2026, 1, 5))
    books.post(invoice.to_entry())
    paid = invoice.total()
    books.post(tally.Entry(date(2026, 1, 28), "Acme pays").debit("1000", paid).credit("1200", paid))
    books.close_period(date(2026, 1, 31))
    return books


if __name__ == "__main__":
    print(close_january().trial_balance())
