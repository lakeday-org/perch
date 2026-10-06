/* Reads postings from stdin, one "account D|C amount" per line, posts them as one entry and prints the trial balance. */
#include <stdio.h>
#include <stdlib.h>

#include "ledger.h"

int main(void)
{
  ledger book;
  ledger_open(&book, USD);
  static char names[MAX_LINES][64];
  char which[8];
  long long minor;
  entry e;
  entry_init(&e, "import");
  size_t read = 0;
  while (read < MAX_LINES && scanf("%63s %7s %lld", names[read], which, &minor) == 3) {
    ledger_open_account(&book, names[read]);
    if (which[0] == 'D') entry_debit(&e, names[read], money_new(minor, USD));
    else entry_credit(&e, names[read], money_new(minor, USD));
    read++;
  }
  if (ledger_post(&book, &e) != 0) {
    fprintf(stderr, "the import does not balance\n");
    return EXIT_FAILURE;
  }
  printf("trial balance: %lld\n", (long long)ledger_trial_balance(&book));
  return EXIT_SUCCESS;
}
