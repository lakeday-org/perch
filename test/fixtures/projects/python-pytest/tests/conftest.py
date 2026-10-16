from datetime import date
from decimal import Decimal

import pytest

from tally import Invoice, Money, open_ledger
from tally.invoicing import InvoiceNumberer


@pytest.fixture
def books():
    return open_ledger("USD")


@pytest.fixture
def numberer():
    return InvoiceNumberer(prefix="INV")


@pytest.fixture
def consulting_invoice():
    invoice = Invoice("Acme Corp", terms="net30")
    invoice.add("Consulting", 10, Money("150.00", "USD"))
    invoice.add("Travel", 1, Money("230.40", "USD"), tax_code="exempt")
    return invoice


@pytest.fixture
def jan_15():
    return date(2026, 1, 15)


def pytest_report_header(config):
    return f"tally decimal context precision: {Decimal(1).as_tuple()}"
