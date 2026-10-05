#include "ledger/currency.hpp"

namespace ledger {

std::string currency_code(Currency currency) {
  switch (currency) {
    case Currency::USD:
      return "USD";
    case Currency::EUR:
      return "EUR";
    case Currency::GBP:
      return "GBP";
    case Currency::JPY:
      return "JPY";
  }
  return "XXX";
}

int minor_units(Currency currency) {
  switch (currency) {
    case Currency::JPY:
      return 0;
    case Currency::USD:
    case Currency::EUR:
    case Currency::GBP:
      return 2;
  }
  return 2;
}

std::optional<Currency> parse_currency(std::string_view code) {
  if (code == "USD") return Currency::USD;
  if (code == "EUR") return Currency::EUR;
  if (code == "GBP") return Currency::GBP;
  if (code == "JPY") return Currency::JPY;
  return std::nullopt;
}

}  // namespace ledger
