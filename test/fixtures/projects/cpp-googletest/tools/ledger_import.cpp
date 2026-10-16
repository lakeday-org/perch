// ledger-import: reads postings, one per line, from standard input and prints the trial balance.
//
//   ledger-import < january.txt
//
// Two consecutive lines make one transaction, the debit first.
#include <iostream>
#include <string>

#include "ledger/ledger.hpp"
#include "ledger/parse.hpp"
#include "ledger/report.hpp"

int main() {
  ledger::Ledger book(ledger::Currency::USD);
  std::string first;
  std::string second;
  int line = 0;
  while (std::getline(std::cin, first) && std::getline(std::cin, second)) {
    line += 2;
    try {
      const auto debit = ledger::parse_posting(first);
      const auto credit = ledger::parse_posting(second);
      for (const auto* posting : {&debit, &credit}) {
        if (!book.has_account(posting->account)) book.open(posting->account, ledger::AccountKind::Asset);
      }
      ledger::Transaction transaction(debit.date);
      transaction.debit(debit.account, debit.amount).credit(credit.account, credit.amount);
      book.post(transaction);
    } catch (const std::exception& error) {
      std::cerr << "line " << line << ": " << error.what() << '\n';
      return 1;
    }
  }
  std::cout << ledger::render_trial_balance(book);
  return 0;
}
