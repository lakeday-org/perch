"""The general ledger as CSV, one row per journal line."""
from __future__ import annotations

import csv
import io

from ..ledger import Ledger


def ledger_rows(ledger: Ledger):
    for number, entry in enumerate(ledger._entries, start=1):
        for line in entry.lines:
            amount = line.amount
            yield {
                "entry": number,
                "date": entry.date.isoformat(),
                "memo": entry.memo,
                "account": line.account,
                "debit": str(amount.amount) if line.side == "debit" else "",
                "credit": str(amount.amount) if line.side == "credit" else "",
                "currency": amount.currency,
            }


def to_csv(ledger: Ledger) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=["entry", "date", "memo", "account", "debit", "credit", "currency"])
    writer.writeheader()
    for row in ledger_rows(ledger):
        writer.writerow(row)
    return buffer.getvalue()
