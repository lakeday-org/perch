#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "ledger/account.hpp"
#include "ledger/money.hpp"

namespace ledger {

class ParseError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

// "12.34" with two minor digits is 1234. A leading '-' is allowed, and no more decimals than `digits`.
std::int64_t parse_amount(std::string_view text, int digits);

// The words of a line, split on runs of spaces and tabs.
std::vector<std::string_view> split_fields(std::string_view text);

// One line of an import file: "2026-01-31 debit cash 12.34 USD".
struct Posting {
  std::string date;
  Side side;
  std::string account;
  Money amount;
};

Posting parse_posting(std::string_view line);

}  // namespace ledger
