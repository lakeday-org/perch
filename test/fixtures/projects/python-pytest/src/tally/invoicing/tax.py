"""Sales tax by code. A compound rule is charged on the net amount plus the simple taxes before it."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, Mapping

from ..money import Money


@dataclass(frozen=True)
class TaxRule:
    code: str
    rate: Decimal
    name: str = ""
    compound: bool = False

    def __post_init__(self) -> None:
        if not Decimal(0) <= self.rate < Decimal(1):
            raise ValueError(f"tax rate {self.rate} is not a fraction between 0 and 1")


DEFAULT_TABLE: Mapping[str, tuple[TaxRule, ...]] = {
    "standard": (TaxRule("standard", Decimal("0.0825"), "State sales tax"),),
    "reduced": (TaxRule("reduced", Decimal("0.04"), "Reduced rate"),),
    "exempt": (),
    "qc": (TaxRule("gst", Decimal("0.05"), "GST"), TaxRule("qst", Decimal("0.09975"), "QST")),
}


def tax_for(net: Money, code: str | None, table: Mapping[str, tuple[TaxRule, ...]] = DEFAULT_TABLE) -> Money:
    """The tax on `net` under `code`, unrounded. No code is no tax."""
    if code is None:
        return Money.zero(net.currency)
    try:
        rules = table[code]
    except KeyError:
        raise ValueError(f"no tax code {code!r}") from None
    simple = Money.zero(net.currency)
    compound = Money.zero(net.currency)
    for rule in rules:
        if rule.compound:
            compound = compound + (net + simple) * rule.rate
        else:
            simple = simple + net * rule.rate
    return simple + compound


def tax_by_code(lines: Iterable[tuple[Money, str | None]], table: Mapping[str, tuple[TaxRule, ...]] = DEFAULT_TABLE) -> dict[str, Money]:
    """Tax summed per code and rounded once per code, which is how a tax return reports it."""
    totals: dict[str, Money] = {}
    for net, code in lines:
        if code is None:
            continue
        tax = tax_for(net, code, table)
        totals[code] = totals[code] + tax if code in totals else tax
    return {code: amount.rounded() for code, amount in totals.items()}
