#include "ledger/ledger.hpp"

namespace ledger {

Ledger::Ledger(Currency currency) : currency_(currency) {}

Account& Ledger::open(const std::string& name, AccountKind kind) {
  auto [it, inserted] = accounts_.try_emplace(name, name, kind, currency_);
  if (!inserted) {
    throw PostingError("account " + name + " is already open");
  }
  return it->second;
}

bool Ledger::has_account(const std::string& name) const {
  return accounts_.count(name) > 0;
}

void Ledger::post(const Transaction& transaction) {
  if (!transaction.is_balanced()) {
    throw PostingError("transaction \"" + transaction.memo() + "\" does not balance");
  }
  for (const Entry& entry : transaction.entries()) {
    if (entry.amount.currency() != currency_) {
      throw PostingError("transaction \"" + transaction.memo() + "\" is in " + currency_code(entry.amount.currency()));
    }
    if (!has_account(entry.account)) {
      throw PostingError("no account named " + entry.account);
    }
  }
  for (const Entry& entry : transaction.entries()) {
    accounts_.at(entry.account).apply(entry.side, entry.amount);
  }
  journal_.push_back(transaction);
}

Money Ledger::balance(const std::string& name) const {
  return find(name).balance();
}

Money Ledger::trial_balance() const {
  Money debits = Money::zero(currency_);
  Money credits = Money::zero(currency_);
  for (const auto& [name, account] : accounts_) {
    if (normal_side(account.kind()) == Side::Debit) {
      debits = debits + account.balance();
    } else {
      credits = credits + account.balance();
    }
  }
  return debits - credits;
}

const Account& Ledger::find(const std::string& name) const {
  auto it = accounts_.find(name);
  if (it == accounts_.end()) {
    throw PostingError("no account named " + name);
  }
  return it->second;
}

}  // namespace ledger
