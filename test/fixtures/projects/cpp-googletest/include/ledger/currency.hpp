#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace ledger {

enum class Currency { USD, EUR, GBP, JPY };

// The ISO 4217 code, "USD".
std::string currency_code(Currency currency);

// Digits after the decimal point: two for most currencies, none for the yen.
int minor_units(Currency currency);

std::optional<Currency> parse_currency(std::string_view code);

}  // namespace ledger
