#include <gtest/gtest.h>

#include "ledger/currency.hpp"

using ledger::Currency;

TEST(Currency, YenHasNoMinorUnits) {
  EXPECT_EQ(ledger::minor_units(Currency::JPY), 0);
  EXPECT_EQ(ledger::minor_units(Currency::EUR), 2);
}

TEST(Currency, ParsesKnownCodes) {
  EXPECT_EQ(ledger::parse_currency("GBP"), Currency::GBP);
  EXPECT_EQ(ledger::currency_code(Currency::GBP), "GBP");
}

TEST(Currency, RejectsUnknownCode) {
  EXPECT_FALSE(ledger::parse_currency("usd").has_value());
  EXPECT_FALSE(ledger::parse_currency("").has_value());
}
