"""The ledger: accounts, posted entries, and balances read from them."""
from __future__ import annotations

from datetime import date

from .accounts import Account, AccountType
from .errors import ClosedPeriod, CurrencyMismatch, UnknownAccount
from .journal import Entry
from .money import Money


class Ledger:
    def __init__(self, currency: str = "USD", *, lock_date: date | None = None) -> None:
        self.currency = currency.upper()
        self.lock_date = lock_date
        self._accounts: dict[str, Account] = {}
        self._entries: list[Entry] = []

    def __len__(self) -> int:
        return len(self._entries)

    def open_account(self, code: str, name: str, type: AccountType, *, parent: str | None = None, placeholder: bool = False) -> Account:
        if code in self._accounts:
            raise ValueError(f"account {code} is already open")
        if parent is not None and parent not in self._accounts:
            raise UnknownAccount(parent)
        account = Account(code, name, type, parent=parent, placeholder=placeholder)
        self._accounts[account.code] = account
        return account

    def account(self, code: str) -> Account:
        try:
            return self._accounts[code]
        except KeyError:
            raise UnknownAccount(code) from None

    def post(self, entry: Entry) -> int:
        """Validates and records an entry, returning its number."""
        entry.validate()
        if entry.currency() != self.currency:
            raise CurrencyMismatch(self.currency, entry.currency())
        if self.lock_date is not None and entry.date <= self.lock_date:
            raise ClosedPeriod(f"{entry.date} is on or before the lock date {self.lock_date}")
        for line in entry.lines:
            account = self.account(line.account)
            if account.placeholder:
                raise ValueError(f"{account.code} is a placeholder and takes no postings")
        self._entries.append(entry)
        return len(self._entries)

    def balance(self, code: str, *, as_of: date | None = None) -> Money:
        """The account's balance on its normal side, its subaccounts included."""
        account = self.account(code)
        codes = {item.code for item in self._accounts.values() if item.is_under(code)}
        total = Money.zero(self.currency)
        for entry in self._entries:
            if as_of is not None and entry.date > as_of:
                continue
            for line in entry.lines:
                if line.account not in codes:
                    continue
                signed = line.amount if line.side == account.type.normal_side else -line.amount
                total = total + signed
        return total

    def trial_balance(self) -> dict[str, tuple[Money, Money]]:
        """Each postable account's balance as a (debit, credit) pair."""
        zero = Money.zero(self.currency)
        rows = {}
        for code, account in sorted(self._accounts.items()):
            if account.placeholder:
                continue
            amount = self.balance(code)
            if account.type.normal_side == "debit":
                rows[code] = (amount, zero) if amount.amount >= 0 else (zero, -amount)
            else:
                rows[code] = (zero, amount) if amount.amount >= 0 else (-amount, zero)
        return rows

    def close_period(self, through: date) -> None:
        if self.lock_date is not None and through < self.lock_date:
            raise ClosedPeriod(f"the books are already closed through {self.lock_date}")
        self.lock_date = through

    def entries_for(self, code: str) -> list[Entry]:
        self.account(code)
        return [entry for entry in self._entries if any(line.account == code for line in entry.lines)]
