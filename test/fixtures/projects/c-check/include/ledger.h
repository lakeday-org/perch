#ifndef LEDGER_H
#define LEDGER_H

#include <stddef.h>
#include <stdint.h>

typedef enum { USD, EUR, JPY } currency;

typedef struct {
  int64_t minor;
  currency unit;
} money;

money money_new(int64_t minor, currency unit);
/* 0 and the sum in *sum, or -1 when the currencies differ. */
int money_add(money a, money b, money *sum);
/* Splits total into parts, the remainder going to the first parts one minor unit at a time; -1 for no parts. */
int money_allocate(money total, int parts, money *out);
int minor_units(currency unit);
const char *currency_code(currency unit);

typedef enum { DEBIT, CREDIT } side;

typedef struct {
  const char *account;
  side which;
  money amount;
} line;

#define MAX_LINES 8

typedef struct {
  const char *memo;
  line lines[MAX_LINES];
  size_t count;
} entry;

void entry_init(entry *e, const char *memo);
int entry_debit(entry *e, const char *account, money amount);
int entry_credit(entry *e, const char *account, money amount);
int entry_is_balanced(const entry *e);
/* 0 when the entry can be posted: two or more lines, none zero, debits equal to credits. */
int entry_validate(const entry *e);

#define MAX_ACCOUNTS 16

typedef struct {
  const char *name;
  int64_t balance;
} account;

typedef struct {
  currency unit;
  account accounts[MAX_ACCOUNTS];
  size_t count;
  int posted;
} ledger;

void ledger_open(ledger *l, currency unit);
int ledger_open_account(ledger *l, const char *name);
/* Applies the entry to every account it names, or to none of them. */
int ledger_post(ledger *l, const entry *e);
int ledger_balance(const ledger *l, const char *name, money *out);
int64_t ledger_trial_balance(const ledger *l);

#endif
