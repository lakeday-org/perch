#include "ledger.h"

money money_new(int64_t minor, currency unit) {
  money m = { minor, unit };
  return m;
}

int money_add(money a, money b, money *sum) {
  if (a.unit != b.unit) return -1;
  sum->minor = a.minor + b.minor;
  sum->unit = a.unit;
  return 0;
}

int money_allocate(money total, int parts, money *out) {
  if (parts <= 0) return -1;
  int64_t share = total.minor / parts;
  int64_t remainder = total.minor - share * parts;
  for (int i = 0; i < parts; i++) {
    out[i].minor = share + (i < remainder ? 1 : 0);
    out[i].unit = total.unit;
  }
  return 0;
}

int minor_units(currency unit) {
  return unit == JPY ? 0 : 2;
}

const char *currency_code(currency unit) {
  switch (unit) {
    case USD: return "USD";
    case EUR: return "EUR";
    case JPY: return "JPY";
  }
  return "???";
}
