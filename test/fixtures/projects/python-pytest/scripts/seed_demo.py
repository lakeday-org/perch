#!/usr/bin/env python3
"""Fills a ledger with a quarter of made-up activity and prints the trial balance, for screenshots and the docs."""
import random
import sys
from datetime import date, timedelta
from decimal import Decimal

sys.path.insert(0, "src")

import tally  # noqa: E402


def seed(books, days=90, seed=7):
    rng = random.Random(seed)
    start = date(2026, 1, 1)
    for offset in range(days):
        amount = tally.Money(Decimal(rng.randint(500, 50000)) / 100, "USD")
        books.post(tally.Entry(start + timedelta(days=offset), "Daily takings").debit("1000", amount).credit("4000", amount))


def main():
    books = tally.open_ledger()
    seed(books)
    for code, (debit, credit) in books.trial_balance().items():
        print(f"{code:<8}{debit.amount:>12}{credit.amount:>12}")


if __name__ == "__main__":
    main()
