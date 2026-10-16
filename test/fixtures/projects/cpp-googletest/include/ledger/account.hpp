#pragma once

#include <string>

#include "ledger/money.hpp"

namespace ledger {

enum class AccountKind { Asset, Liability, Equity, Income, Expense };

enum class Side { Debit, Credit };

// The side that increases an account of this kind.
Side normal_side(AccountKind kind);

class Account {
 public:
  Account(std::string name, AccountKind kind, Currency currency);

  const std::string& name() const { return name_; }
  AccountKind kind() const { return kind_; }
  const Money& balance() const { return balance_; }

  void apply(Side side, const Money& amount);

  // True when the balance has crossed to the side opposite its normal one, as an overdrawn bank account does.
  bool is_contra() const;

 private:
  std::string name_;
  AccountKind kind_;
  Money balance_;
};

}  // namespace ledger
