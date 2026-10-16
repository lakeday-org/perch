#include <string.h>

#include "ledger.h"

void entry_init(entry *e, const char *memo) {
  memset(e, 0, sizeof *e);
  e->memo = memo;
}

static int add_line(entry *e, const char *account, side which, money amount) {
  if (e->count >= MAX_LINES) return -1;
  e->lines[e->count].account = account;
  e->lines[e->count].which = which;
  e->lines[e->count].amount = amount;
  e->count++;
  return 0;
}

int entry_debit(entry *e, const char *account, money amount) {
  return add_line(e, account, DEBIT, amount);
}

int entry_credit(entry *e, const char *account, money amount) {
  return add_line(e, account, CREDIT, amount);
}

int entry_is_balanced(const entry *e) {
  int64_t debits = 0, credits = 0;
  for (size_t i = 0; i < e->count; i++) {
    if (e->lines[i].which == DEBIT) debits += e->lines[i].amount.minor;
    else credits += e->lines[i].amount.minor;
  }
  return debits == credits;
}

int entry_validate(const entry *e) {
  if (e->count < 2) return -1;
  for (size_t i = 0; i < e->count; i++) {
    if (e->lines[i].amount.minor == 0) return -1;
  }
  return entry_is_balanced(e) ? 0 : -1;
}
