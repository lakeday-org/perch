#include "ledger/transaction.hpp"

#include <stdexcept>
#include <utility>

namespace ledger {

Transaction::Transaction(std::string memo) : memo_(std::move(memo)) {}

Transaction& Transaction::debit(std::string account, Money amount) {
  return add(std::move(account), Side::Debit, amount);
}

Transaction& Transaction::credit(std::string account, Money amount) {
  return add(std::move(account), Side::Credit, amount);
}

Transaction& Transaction::add(std::string account, Side side, Money amount) {
  if (amount.is_negative() || amount.is_zero()) {
    throw std::invalid_argument("an entry's amount must be positive");
  }
  if (!entries_.empty() && entries_.front().amount.currency() != amount.currency()) {
    throw std::invalid_argument("a transaction is in one currency");
  }
  entries_.push_back(Entry{std::move(account), side, amount});
  return *this;
}

bool Transaction::is_balanced() const {
  if (entries_.size() < 2) {
    return false;
  }
  return total(Side::Debit) == total(Side::Credit);
}

Money Transaction::total(Side side) const {
  Money sum = Money::zero(entries_.empty() ? Currency::USD : entries_.front().amount.currency());
  for (const Entry& entry : entries_) {
    if (entry.side == side) {
      sum = sum + entry.amount;
    }
  }
  return sum;
}

}  // namespace ledger
