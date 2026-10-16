#include <gtest/gtest.h>

#include <cstdint>
#include <string>

#include "ledger/parse.hpp"

using ledger::ParseError;

struct AmountCase {
  const char* text;
  int digits;
  std::int64_t minor;
};

// Names the case in the JUnit report instead of a dump of its bytes.
void PrintTo(const AmountCase& c, std::ostream* os) { *os << '"' << c.text << "\" with " << c.digits << " digits"; }

class ParseAmountTest : public ::testing::TestWithParam<AmountCase> {};

TEST_P(ParseAmountTest, ParsesToMinorUnits) {
  const AmountCase& c = GetParam();
  EXPECT_EQ(ledger::parse_amount(c.text, c.digits), c.minor);
}

INSTANTIATE_TEST_SUITE_P(Amounts, ParseAmountTest,
                         ::testing::Values(AmountCase{"12.34", 2, 1234}, AmountCase{"12.3", 2, 1230},
                                           AmountCase{"12", 2, 1200}, AmountCase{"-0.05", 2, -5},
                                           AmountCase{"1500", 0, 1500}));

class MalformedAmountTest : public ::testing::TestWithParam<std::string> {};

TEST_P(MalformedAmountTest, Throws) {
  EXPECT_THROW(ledger::parse_amount(GetParam(), 2), ParseError);
}

INSTANTIATE_TEST_SUITE_P(Malformed, MalformedAmountTest, ::testing::Values("", "-", "1.2.3", "12.345", "12a"));

TEST(ParsePosting, ReadsAnImportLine) {
  const auto posting = ledger::parse_posting("2026-01-31 debit  cash 12.34 USD");
  EXPECT_EQ(posting.date, "2026-01-31");
  EXPECT_EQ(posting.side, ledger::Side::Debit);
  EXPECT_EQ(posting.account, "cash");
  EXPECT_EQ(posting.amount, ledger::Money(1234, ledger::Currency::USD));
}

TEST(ParsePosting, RejectsAnUnknownSide) {
  EXPECT_THROW(ledger::parse_posting("2026-01-31 withdraw cash 12.34 USD"), ParseError);
}

TEST(ParsePosting, RejectsAnUnknownCurrency) {
  EXPECT_THROW(ledger::parse_posting("2026-01-31 credit sales 12.34 XBT"), ParseError);
}

TEST(SplitFields, CollapsesRunsOfWhitespace) {
  const auto fields = ledger::split_fields("  a \t b   c ");
  ASSERT_EQ(fields.size(), 3u);
  EXPECT_EQ(fields[2], "c");
}
