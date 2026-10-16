#pragma once

#include <cstddef>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#include "ledger/account.hpp"
#include "ledger/transaction.hpp"

namespace ledger {

class PostingError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

class Ledger {
 public:
  explicit Ledger(Currency currency);

  Account& open(const std::string& name, AccountKind kind);
  bool has_account(const std::string& name) const;

  // Applies every entry or none: an unbalanced transaction, or one naming an account that is not open, changes nothing.
  void post(const Transaction& transaction);

  Money balance(const std::string& name) const;

  // Debit balances less credit balances: zero for a ledger that has only ever taken balanced transactions.
  Money trial_balance() const;

  std::size_t posted() const { return journal_.size(); }
  const std::map<std::string, Account>& accounts() const { return accounts_; }

 private:
  const Account& find(const std::string& name) const;

  Currency currency_;
  std::map<std::string, Account> accounts_;
  std::vector<Transaction> journal_;
};

}  // namespace ledger
