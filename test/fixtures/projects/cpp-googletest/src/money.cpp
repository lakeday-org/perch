#include "ledger/money.hpp"

#include <cstdlib>
#include <stdexcept>

namespace ledger {

Money::Money(std::int64_t minor, Currency currency) : minor_(minor), currency_(currency) {}

Money Money::zero(Currency currency) {
  return Money(0, currency);
}

bool Money::is_negative() const {
  return minor_ < 0;
}

Money Money::operator+(const Money& other) const {
  require_same_currency(other);
  return Money(minor_ + other.minor_, currency_);
}

Money Money::operator-(const Money& other) const {
  require_same_currency(other);
  return Money(minor_ - other.minor_, currency_);
}

Money Money::negated() const {
  return Money(-minor_, currency_);
}

std::vector<Money> Money::allocate(int parts) const {
  if (parts <= 0) {
    throw std::invalid_argument("allocate needs at least one part");
  }
  std::vector<Money> shares;
  shares.reserve(static_cast<std::size_t>(parts));
  const std::int64_t base = minor_ / parts;
  std::int64_t remainder = minor_ % parts;
  for (int i = 0; i < parts; ++i) {
    std::int64_t share = base;
    if (remainder > 0) {
      ++share;
      --remainder;
    } else if (remainder < 0) {
      --share;
      ++remainder;
    }
    shares.emplace_back(share, currency_);
  }
  return shares;
}

std::string Money::to_string() const {
  const int digits = minor_units(currency_);
  const std::int64_t magnitude = std::llabs(minor_);
  std::string text;
  if (digits == 0) {
    text = std::to_string(magnitude);
  } else {
    std::int64_t scale = 1;
    for (int i = 0; i < digits; ++i) scale *= 10;
    std::string fraction = std::to_string(magnitude % scale);
    fraction.insert(0, static_cast<std::size_t>(digits) - fraction.size(), '0');
    text = std::to_string(magnitude / scale) + "." + fraction;
  }
  return (minor_ < 0 ? "-" : "") + text + " " + currency_code(currency_);
}

void Money::require_same_currency(const Money& other) const {
  if (currency_ != other.currency_) {
    throw std::domain_error("cannot combine " + currency_code(currency_) + " with " + currency_code(other.currency_));
  }
}

bool operator==(const Money& a, const Money& b) {
  return a.currency() == b.currency() && a.minor() == b.minor();
}

bool operator!=(const Money& a, const Money& b) {
  return !(a == b);
}

}  // namespace ledger
