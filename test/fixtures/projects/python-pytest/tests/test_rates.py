import io
import json
from decimal import Decimal
from unittest.mock import patch

import pytest

from tally import Money
from tally.rates import RateProvider, convert


def rates_response(base, rates, result="success"):
    body = json.dumps({"result": result, "base_code": base, "rates": rates}).encode()
    return io.BytesIO(body)


def test_same_currency_needs_no_request():
    provider = RateProvider()
    with patch("tally.rates.urlopen") as urlopen:
        assert provider.rate("USD", "USD") == Decimal(1)
    urlopen.assert_not_called()


@patch("tally.rates.urlopen")
def test_rates_are_fetched_once_per_base(urlopen):
    urlopen.return_value = rates_response("USD", {"EUR": 0.9213, "GBP": 0.7841})
    provider = RateProvider("https://rates.example/v6/latest/")
    assert provider.rate("USD", "EUR") == Decimal("0.9213")
    assert provider.rate("USD", "GBP") == Decimal("0.7841")
    urlopen.assert_called_once_with("https://rates.example/v6/latest/USD", timeout=5.0)


def test_convert_rounds_to_the_target_currency():
    with patch("tally.rates.urlopen", return_value=rates_response("USD", {"JPY": 151.237})):
        assert convert(Money("19.99", "USD"), "JPY", RateProvider()) == Money("3023", "JPY")


def test_service_error_is_raised():
    with patch("tally.rates.urlopen", return_value=rates_response("USD", {}, result="error")):
        with pytest.raises(RuntimeError):
            RateProvider().rate("USD", "EUR")
