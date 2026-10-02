#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "ledger/currency.hpp"

namespace ledger {

// An amount in a currency's minor units, so 12.34 USD is 1234.
class Money {
 public:
  Money(std::int64_t minor, Currency currency);

  static Money zero(Currency currency);

  std::int64_t minor() const { return minor_; }
  Currency currency() const { return currency_; }
  bool is_zero() const { return minor_ == 0; }
  bool is_negative() const;

  Money operator+(const Money& other) const;
  Money operator-(const Money& other) const;
  Money negated() const;

  // Splits into `parts` amounts that differ by at most one minor unit and add up to this one.
  std::vector<Money> allocate(int parts) const;

  // "12.34 USD", "-5 JPY".
  std::string to_string() const;

 private:
  void require_same_currency(const Money& other) const;

  std::int64_t minor_;
  Currency currency_;
};

bool operator==(const Money& a, const Money& b);
bool operator!=(const Money& a, const Money& b);

}  // namespace ledger
