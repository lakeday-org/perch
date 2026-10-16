#pragma once

#include <string>
#include <vector>

#include "ledger/account.hpp"
#include "ledger/money.hpp"

namespace ledger {

struct Entry {
  std::string account;
  Side side;
  Money amount;
};

// A journal entry: debits and credits that should add up to the same amount.
class Transaction {
 public:
  explicit Transaction(std::string memo);

  Transaction& debit(std::string account, Money amount);
  Transaction& credit(std::string account, Money amount);

  const std::string& memo() const { return memo_; }
  const std::vector<Entry>& entries() const { return entries_; }

  bool is_balanced() const;
  Money total(Side side) const;

 private:
  Transaction& add(std::string account, Side side, Money amount);

  std::string memo_;
  std::vector<Entry> entries_;
};

}  // namespace ledger
