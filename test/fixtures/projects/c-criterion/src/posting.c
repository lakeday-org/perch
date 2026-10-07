#include <string.h>

#include "parse.h"

int parse_posting(char *line, posting *out) {
  char *fields[MAX_FIELDS];
  int count = split_fields(trim(line), fields);
  if (count != 3) return -1;
  out->account = fields[0];
  if (strcmp(fields[1], "D") == 0) out->side = POSTING_DEBIT;
  else if (strcmp(fields[1], "C") == 0) out->side = POSTING_CREDIT;
  else return -1;
  return parse_amount(fields[2], &out->minor);
}
