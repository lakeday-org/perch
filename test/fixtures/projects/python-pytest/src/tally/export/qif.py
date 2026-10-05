"""Quicken Interchange Format, for the bank-statement importers that still only read QIF."""
from __future__ import annotations

from ..journal import Entry


def qif_date(entry: Entry) -> str:
    return entry.date.strftime("%m/%d'%y")


def entry_to_qif(entry: Entry, account: str) -> str:
    lines = [f"D{qif_date(entry)}"]
    for line in entry.lines:
        if line.account != account:
            continue
        amount = line.amount.amount if line.side == "debit" else -line.amount.amount
        lines.append(f"T{amount:.2f}")
    if entry.memo:
        lines.append(f"M{entry.memo}")
    lines.append("^")
    return "\n".join(lines)
