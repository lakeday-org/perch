/* Reads postings from stdin and echoes each one it could parse, with the amount formatted. */
#include <stdio.h>
#include <string.h>

#include "parse.h"

int main(void) {
  char line[128], amount[32];
  posting p;
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\n")] = '\0';
    if (parse_posting(line, &p) != 0) {
      fprintf(stderr, "could not read: %s\n", line);
      continue;
    }
    format_amount(p.minor, amount, sizeof amount);
    printf("%s %s %s\n", p.account, p.side == POSTING_DEBIT ? "debit" : "credit", amount);
  }
  return 0;
}
