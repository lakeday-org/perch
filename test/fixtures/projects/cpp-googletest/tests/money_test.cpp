#include <gtest/gtest.h>

#include <stdexcept>

#include "ledger/money.hpp"

using ledger::Currency;
using ledger::Money;

TEST(Money, AddsAmountsInOneCurrency) {
  const Money sum = Money(1250, Currency::USD) + Money(75, Currency::USD);
  EXPECT_EQ(sum, Money(1325, Currency::USD));
}

TEST(Money, RefusesToAddAcrossCurrencies) {
  EXPECT_THROW(Money(100, Currency::USD) + Money(100, Currency::EUR), std::domain_error);
}

TEST(Money, AllocatesTheRemainderToTheFirstShares) {
  const auto shares = Money(1000, Currency::USD).allocate(3);
  ASSERT_EQ(shares.size(), 3u);
  EXPECT_EQ(shares[0].minor(), 334);
  EXPECT_EQ(shares[1].minor(), 333);
  EXPECT_EQ(shares[2].minor(), 333);
}

TEST(Money, AllocatesANegativeAmount) {
  const auto shares = Money(-5, Currency::EUR).allocate(2);
  EXPECT_EQ(shares[0].minor(), -3);
  EXPECT_EQ(shares[1].minor(), -2);
}

TEST(Money, RejectsAllocationIntoZeroParts) {
  EXPECT_THROW(Money(10, Currency::USD).allocate(0), std::invalid_argument);
}

TEST(Money, FormatsCentsWithTwoDigits) {
  EXPECT_EQ(Money(1205, Currency::USD).to_string(), "12.05 USD");
}

TEST(Money, FormatsYenWithoutDecimals) {
  EXPECT_EQ(Money(1500, Currency::JPY).to_string(), "1500 JPY");
}

// Accounting style puts a negative amount in parentheses. to_string still writes a minus sign.
TEST(Money, FormatsANegativeAmountInParentheses) {
  EXPECT_EQ(Money(-1234, Currency::GBP).to_string(), "(12.34) GBP");
}

// Waiting on banker's rounding in allocate.
TEST(Money, DISABLED_RoundsHalfToEven) {
  const auto shares = Money(5, Currency::USD).allocate(2);
  EXPECT_EQ(shares[0].minor(), 2);
}
