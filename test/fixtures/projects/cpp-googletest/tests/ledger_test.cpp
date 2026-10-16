#include <gtest/gtest.h>

#include "ledger/ledger.hpp"

using namespace ledger;

class LedgerTest : public ::testing::Test {
 protected:
  void SetUp() override {
    book_.open("cash", AccountKind::Asset);
    book_.open("sales", AccountKind::Income);
    book_.open("payable", AccountKind::Liability);
  }

  static Money usd(std::int64_t cents) { return Money(cents, Currency::USD); }

  Ledger book_{Currency::USD};
};

TEST_F(LedgerTest, PostsABalancedTransaction) {
  Transaction sale("invoice 1041");
  sale.debit("cash", usd(4999)).credit("sales", usd(4999));
  book_.post(sale);
  EXPECT_EQ(book_.balance("cash"), usd(4999));
  EXPECT_EQ(book_.balance("sales"), usd(4999));
  EXPECT_EQ(book_.posted(), 1u);
}

TEST_F(LedgerTest, RejectsAnUnbalancedTransaction) {
  Transaction partial("partial");
  partial.debit("cash", usd(100)).credit("sales", usd(90));
  EXPECT_THROW(book_.post(partial), PostingError);
  EXPECT_EQ(book_.posted(), 0u);
}

TEST_F(LedgerTest, LeavesEveryAccountAloneWhenOneIsUnknown) {
  Transaction typo("typo");
  typo.debit("cash", usd(100)).credit("slaes", usd(100));
  EXPECT_THROW(book_.post(typo), PostingError);
  EXPECT_TRUE(book_.balance("cash").is_zero());
}

TEST_F(LedgerTest, TrialBalanceIsZeroAfterPosting) {
  Transaction bill("supplier bill");
  bill.debit("cash", usd(2500)).credit("payable", usd(2500));
  book_.post(bill);
  Transaction sale("cash sale");
  sale.debit("cash", usd(800)).credit("sales", usd(800));
  book_.post(sale);
  EXPECT_TRUE(book_.trial_balance().is_zero());
}

TEST_F(LedgerTest, RefusesToOpenAnAccountTwice) {
  EXPECT_THROW(book_.open("cash", AccountKind::Asset), PostingError);
}

TEST_F(LedgerTest, ReportsAnUnknownAccountsBalance) {
  EXPECT_THROW(book_.balance("petty cash"), PostingError);
}

TEST(NormalSide, AssetsAndExpensesIncreaseOnTheDebitSide) {
  EXPECT_EQ(normal_side(AccountKind::Asset), Side::Debit);
  EXPECT_EQ(normal_side(AccountKind::Expense), Side::Debit);
  EXPECT_EQ(normal_side(AccountKind::Income), Side::Credit);
}
