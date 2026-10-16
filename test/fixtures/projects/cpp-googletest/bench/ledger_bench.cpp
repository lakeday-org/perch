// Posts a million two-line transactions and prints how long it took.
#include <chrono>
#include <iostream>

#include "ledger/ledger.hpp"

int main() {
  using clock = std::chrono::steady_clock;
  ledger::Ledger book(ledger::Currency::USD);
  book.open("cash", ledger::AccountKind::Asset);
  book.open("sales", ledger::AccountKind::Income);
  const auto start = clock::now();
  for (int i = 1; i <= 1'000'000; ++i) {
    ledger::Transaction sale("sale");
    sale.debit("cash", ledger::Money(i, ledger::Currency::USD)).credit("sales", ledger::Money(i, ledger::Currency::USD));
    book.post(sale);
  }
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - start);
  std::cout << book.posted() << " transactions in " << elapsed.count() << " ms\n";
  return 0;
}
