#include <string.h>

#include "ledger.h"

void ledger_open(ledger *l, currency unit) {
  memset(l, 0, sizeof *l);
  l->unit = unit;
}

static account *find_account(const ledger *l, const char *name) {
  for (size_t i = 0; i < l->count; i++) {
    if (strcmp(l->accounts[i].name, name) == 0) return (account *)&l->accounts[i];
  }
  return NULL;
}

int ledger_open_account(ledger *l, const char *name) {
  if (find_account(l, name) || l->count >= MAX_ACCOUNTS) return -1;
  l->accounts[l->count].name = name;
  l->accounts[l->count].balance = 0;
  l->count++;
  return 0;
}

int ledger_post(ledger *l, const entry *e) {
  if (entry_validate(e) != 0) return -1;
  for (size_t i = 0; i < e->count; i++) {
    if (!find_account(l, e->lines[i].account)) return -1;
    if (e->lines[i].amount.unit != l->unit) return -1;
  }
  for (size_t i = 0; i < e->count; i++) {
    account *a = find_account(l, e->lines[i].account);
    if (e->lines[i].which == DEBIT) a->balance += e->lines[i].amount.minor;
    else a->balance -= e->lines[i].amount.minor;
  }
  l->posted++;
  return 0;
}

int ledger_balance(const ledger *l, const char *name, money *out) {
  account *a = find_account(l, name);
  if (!a) return -1;
  *out = money_new(a->balance, l->unit);
  return 0;
}

int64_t ledger_trial_balance(const ledger *l) {
  int64_t total = 0;
  for (size_t i = 0; i < l->count; i++) total += l->accounts[i].balance;
  return total;
}
