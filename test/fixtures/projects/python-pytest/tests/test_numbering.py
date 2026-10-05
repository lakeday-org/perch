from datetime import date

from tally.invoicing import InvoiceNumberer


def test_sequence_restarts_each_year(numberer):
    assert numberer.next(date(2026, 12, 30)) == "INV-2026-0001"
    assert numberer.next(date(2026, 12, 31)) == "INV-2026-0002"
    assert numberer.next(date(2027, 1, 1)) == "INV-2027-0001"


def test_peek_does_not_advance():
    numberer = InvoiceNumberer("CR", width=6, per_year=False)
    assert numberer.peek(date(2026, 1, 1)) == "CR-000001"
    assert numberer.next(date(2026, 1, 1)) == "CR-000001"
    assert numberer.peek(date(2027, 1, 1)) == "CR-000002"
