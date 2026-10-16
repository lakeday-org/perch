"""The chart of accounts: what an account is and which side it grows on."""
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

_CODE = re.compile(r"^\d{4}(?:-\d{2})?$")


class AccountType(Enum):
    ASSET = "asset"
    LIABILITY = "liability"
    EQUITY = "equity"
    INCOME = "income"
    EXPENSE = "expense"

    @property
    def normal_side(self) -> str:
        """Debit for assets and expenses, credit for the rest."""
        if self in (AccountType.ASSET, AccountType.EXPENSE):
            return "debit"
        return "credit"


@dataclass
class Account:
    code: str
    name: str
    type: AccountType
    parent: str | None = None
    placeholder: bool = False

    def __post_init__(self) -> None:
        self.code = validate_code(self.code)
        if self.parent is not None and not self.code.startswith(self.parent):
            raise ValueError(f"{self.code} cannot sit under {self.parent}")

    def is_under(self, code: str) -> bool:
        return self.code == code or self.parent == code


def validate_code(code: str) -> str:
    """Four digits, optionally a dash and a two-digit subaccount: `1200` or `1200-01`."""
    code = code.strip()
    if not _CODE.match(code):
        raise ValueError(f"account codes look like 1200 or 1200-01, not {code!r}")
    return code
