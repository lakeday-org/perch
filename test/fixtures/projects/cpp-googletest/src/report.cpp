#include "ledger/report.hpp"

#include <sstream>

namespace ledger {

namespace {

const char* kind_label(AccountKind kind) {
  switch (kind) {
    case AccountKind::Asset:
      return "asset";
    case AccountKind::Liability:
      return "liability";
    case AccountKind::Equity:
      return "equity";
    case AccountKind::Income:
      return "income";
    case AccountKind::Expense:
      return "expense";
  }
  return "?";
}

}  // namespace

std::string pad_right(std::string text, std::size_t width) {
  if (text.size() < width) {
    text.append(width - text.size(), ' ');
  }
  return text;
}

std::string render_trial_balance(const Ledger& ledger) {
  std::ostringstream out;
  for (const auto& [name, account] : ledger.accounts()) {
    out << pad_right(name, 24) << pad_right(kind_label(account.kind()), 12) << account.balance().to_string();
    if (account.is_contra()) {
      out << "  (contra)";
    }
    out << '\n';
  }
  out << pad_right("trial balance", 36) << ledger.trial_balance().to_string() << '\n';
  return out.str();
}

}  // namespace ledger
