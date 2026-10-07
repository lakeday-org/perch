#include <ctype.h>
#include <stdio.h>

#include "parse.h"

int parse_amount(const char *text, long *out) {
  if (text == NULL || *text == '\0') return -1;
  int negative = 0;
  if (*text == '-') {
    negative = 1;
    text++;
  }
  long whole = 0, cents = 0;
  int digits = 0;
  while (isdigit((unsigned char)*text)) {
    whole = whole * 10 + (*text - '0');
    text++;
    digits++;
  }
  if (digits == 0) return -1;
  if (*text == '.') {
    text++;
    int places = 0;
    while (isdigit((unsigned char)*text) && places < 2) {
      cents = cents * 10 + (*text - '0');
      text++;
      places++;
    }
    if (places == 0 || isdigit((unsigned char)*text)) return -1;
    if (places == 1) cents *= 10;
  }
  if (*text != '\0') return -1;
  long minor = whole * 100 + cents;
  *out = negative ? -minor : minor;
  return 0;
}

int format_amount(long minor, char *buffer, size_t size) {
  const char *sign = minor < 0 ? "-" : "";
  if (minor < 0) minor = -minor;
  return snprintf(buffer, size, "%s%ld.%02ld", sign, minor / 100, minor % 100);
}
