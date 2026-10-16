#include <gtest/gtest.h>

#include <stdexcept>

#include "ledger/transaction.hpp"

using ledger::Currency;
using ledger::Money;
using ledger::Side;
using ledger::Transaction;

namespace {

Money usd(std::int64_t cents) { return Money(cents, Currency::USD); }

}  // namespace

TEST(Transaction, BalancesWhenDebitsEqualCredits) {
  Transaction rent("March rent");
  rent.debit("rent", usd(120000)).credit("cash", usd(120000));
  EXPECT_TRUE(rent.is_balanced());
}

TEST(Transaction, OneSidedIsNotBalanced) {
  Transaction draft("draft");
  draft.debit("cash", usd(500));
  EXPECT_FALSE(draft.is_balanced());
}

TEST(Transaction, RejectsAZeroAmount) {
  Transaction empty("nothing");
  EXPECT_THROW(empty.debit("cash", usd(0)), std::invalid_argument);
}

TEST(Transaction, RejectsMixedCurrencies) {
  Transaction mixed("mixed");
  mixed.debit("cash", usd(100));
  EXPECT_THROW(mixed.credit("sales", Money(100, Currency::EUR)), std::invalid_argument);
}

TEST(Transaction, TotalsOneSide) {
  Transaction split("split payment");
  split.debit("cash", usd(700)).debit("card", usd(300)).credit("sales", usd(1000));
  EXPECT_EQ(split.total(Side::Debit), usd(1000));
  EXPECT_EQ(split.total(Side::Credit), usd(1000));
}
