"""Every error tally raises is a TallyError."""


class TallyError(Exception):
    """Base class for tally's errors."""


class CurrencyMismatch(TallyError):
    def __init__(self, left: str, right: str) -> None:
        super().__init__(f"cannot combine {left} with {right}")
        self.left = left
        self.right = right


class UnbalancedEntry(TallyError):
    """Debits and credits of a journal entry differ."""


class UnknownAccount(TallyError):
    def __init__(self, code: str) -> None:
        super().__init__(f"no account {code!r}")
        self.code = code


class ClosedPeriod(TallyError):
    """An entry is dated on or before the ledger's lock date."""
