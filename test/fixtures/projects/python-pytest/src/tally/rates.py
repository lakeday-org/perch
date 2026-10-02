"""Exchange rates from a JSON rates service, cached for the life of the provider."""
from __future__ import annotations

import json
from decimal import Decimal
from urllib.request import urlopen

from .money import Money


class RateProvider:
    def __init__(self, base_url: str = "https://open.er-api.com/v6/latest", *, timeout: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._cache: dict[str, dict[str, Decimal]] = {}

    def _fetch(self, base: str) -> dict[str, Decimal]:
        with urlopen(f"{self.base_url}/{base}", timeout=self.timeout) as response:
            payload = json.load(response)
        if payload.get("result") != "success":
            raise RuntimeError(f"rates service said {payload.get('error-type', 'no')}")
        return {code: Decimal(str(rate)) for code, rate in payload["rates"].items()}

    def rate(self, base: str, quote: str) -> Decimal:
        if base == quote:
            return Decimal(1)
        if base not in self._cache:
            self._cache[base] = self._fetch(base)
        try:
            return self._cache[base][quote]
        except KeyError:
            raise ValueError(f"no rate from {base} to {quote}") from None


def convert(amount: Money, to: str, provider: RateProvider) -> Money:
    return Money(amount.amount * provider.rate(amount.currency, to), to).rounded()
