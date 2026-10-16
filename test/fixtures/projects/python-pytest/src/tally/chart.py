"""A starting chart of accounts, so a new ledger can take postings straight away."""
from __future__ import annotations

from .accounts import AccountType
from .ledger import Ledger

SMALL_BUSINESS = (
    ("1000", "Cash", AccountType.ASSET),
    ("1200", "Accounts receivable", AccountType.ASSET),
    ("1500", "Equipment", AccountType.ASSET),
    ("2000", "Accounts payable", AccountType.LIABILITY),
    ("2200", "Sales tax payable", AccountType.LIABILITY),
    ("3000", "Owner's equity", AccountType.EQUITY),
    ("4000", "Sales", AccountType.INCOME),
    ("4100", "Services", AccountType.INCOME),
    ("5000", "Cost of goods sold", AccountType.EXPENSE),
    ("6000", "Operating expenses", AccountType.EXPENSE),
)


def open_ledger(currency: str = "USD", chart=SMALL_BUSINESS) -> Ledger:
    """A ledger with `chart` already open."""
    ledger = Ledger(currency)
    for code, name, type in chart:
        ledger.open_account(code, name, type)
    return ledger
