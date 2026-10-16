#include "ledger/account.hpp"

#include <utility>

namespace ledger {

Side normal_side(AccountKind kind) {
  switch (kind) {
    case AccountKind::Asset:
    case AccountKind::Expense:
      return Side::Debit;
    case AccountKind::Liability:
    case AccountKind::Equity:
    case AccountKind::Income:
      return Side::Credit;
  }
  return Side::Debit;
}

Account::Account(std::string name, AccountKind kind, Currency currency)
    : name_(std::move(name)), kind_(kind), balance_(Money::zero(currency)) {}

void Account::apply(Side side, const Money& amount) {
  if (side == normal_side(kind_)) {
    balance_ = balance_ + amount;
  } else {
    balance_ = balance_ - amount;
  }
}

bool Account::is_contra() const {
  return balance_.is_negative();
}

}  // namespace ledger
