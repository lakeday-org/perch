#ifndef PARSE_H
#define PARSE_H

#include <stddef.h>

/* Reads "12.34" or "-7" into minor units: 0 with the amount in *out, or -1 for anything else. */
int parse_amount(const char *text, long *out);
/* Writes minor units as "12.34"; how many characters that took. */
int format_amount(long minor, char *buffer, size_t size);

#define MAX_FIELDS 8

/* Splits a line on runs of whitespace, in place, into at most MAX_FIELDS fields. The count. */
int split_fields(char *line, char **fields);
/* Trims whitespace from both ends in place; where what is left starts. */
char *trim(char *text);

typedef enum { POSTING_DEBIT, POSTING_CREDIT } posting_side;

typedef struct {
  char *account;
  posting_side side;
  long minor;
} posting;

/* Reads "account D|C amount": 0, or -1 when a field is missing or malformed. */
int parse_posting(char *line, posting *out);

#endif
