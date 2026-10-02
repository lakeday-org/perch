from datetime import date
from decimal import Decimal

import pytest

from tally import AccountType, ClosedPeriod, Entry, Ledger, Money, UnknownAccount, open_ledger
from tests.test_journal import cash_sale


def usd(amount):
    return Money(Decimal(amount), "USD")


class TestPosting:
    def test_post_moves_both_balances(self, books):
        number = books.post(cash_sale("250.00"))
        assert number == 1
        assert books.balance("1000") == usd("250.00")
        assert books.balance("4000") == usd("250.00")

    def test_post_to_an_unknown_account_raises(self, books):
        entry = Entry(date(2026, 3, 2)).debit("1999", usd("5")).credit("4000", usd("5"))
        with pytest.raises(UnknownAccount):
            books.post(entry)

    def test_post_on_the_lock_date_is_rejected(self):
        ledger = Ledger("USD", lock_date=date(2026, 3, 31))
        ledger.open_account("1000", "Cash", AccountType.ASSET)
        ledger.open_account("4000", "Sales", AccountType.INCOME)
        with pytest.raises(ClosedPeriod):
            ledger.post(cash_sale("10.00"))

    def test_post_to_a_placeholder_is_rejected(self):
        ledger = Ledger()
        ledger.open_account("1000", "Cash", AccountType.ASSET, placeholder=True)
        ledger.open_account("4000", "Sales", AccountType.INCOME)
        with pytest.raises(ValueError, match="placeholder"):
            ledger.post(cash_sale("10.00"))


def test_balance_includes_subaccounts():
    ledger = Ledger()
    ledger.open_account("6000", "Operating expenses", AccountType.EXPENSE, placeholder=True)
    ledger.open_account("6000-01", "Rent", AccountType.EXPENSE, parent="6000")
    ledger.open_account("6000-02", "Software", AccountType.EXPENSE, parent="6000")
    ledger.open_account("1000", "Cash", AccountType.ASSET)
    ledger.post(Entry(date(2026, 2, 1)).debit("6000-01", usd("1800")).credit("1000", usd("1800")))
    ledger.post(Entry(date(2026, 2, 3)).debit("6000-02", usd("49.99")).credit("1000", usd("49.99")))
    assert ledger.balance("6000") == usd("1849.99")
    assert ledger.balance("1000") == usd("-1849.99")


def test_balance_as_of_leaves_out_later_entries(books):
    books.post(cash_sale("10.00"))
    later = cash_sale("5.00")
    later.date = date(2026, 4, 1)
    books.post(later)
    assert books.balance("4000", as_of=date(2026, 3, 31)) == usd("10.00")


def test_trial_balance_debits_equal_credits(books):
    books.post(cash_sale("100.00", tax="8.25"))
    rows = books.trial_balance()
    debits = sum((debit.amount for debit, _ in rows.values()), Decimal(0))
    credits = sum((credit.amount for _, credit in rows.values()), Decimal(0))
    assert debits == credits == Decimal("108.25")


def test_close_period_cannot_move_backwards():
    ledger = open_ledger()
    ledger.close_period(date(2026, 6, 30))
    with pytest.raises(ClosedPeriod):
        ledger.close_period(date(2026, 3, 31))


@pytest.mark.skip(reason="multi-currency ledgers are planned for 0.5")
def test_post_in_a_foreign_currency_converts():
    books = open_ledger("USD")
    entry = Entry(date(2026, 3, 2)).debit("1000", Money("100", "EUR")).credit("4000", Money("100", "EUR"))
    books.post(entry)
    assert books.balance("1000").currency == "USD"
