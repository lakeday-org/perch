#include <criterion/criterion.h>
#include <string.h>

#include "parse.h"

static char line[64];
static posting got;

static void copy_line(const char *text) {
  strncpy(line, text, sizeof line - 1);
  line[sizeof line - 1] = '\0';
}

Test(posting, reads_an_import_line) {
  copy_line("cash D 49.99");
  cr_assert_eq(parse_posting(line, &got), 0);
  cr_assert_str_eq(got.account, "cash");
  cr_assert_eq(got.side, POSTING_DEBIT);
  cr_assert_eq(got.minor, 4999);
}

Test(posting, collapses_runs_of_whitespace) {
  copy_line("  sales   C   10 ");
  cr_assert_eq(parse_posting(line, &got), 0);
  cr_assert_eq(got.side, POSTING_CREDIT);
  cr_assert_eq(got.minor, 1000);
}

Test(posting, rejects_an_unknown_side) {
  copy_line("cash X 1");
  cr_assert_neq(parse_posting(line, &got), 0);
}

Test(posting, rejects_a_missing_amount) {
  copy_line("cash D");
  cr_assert_neq(parse_posting(line, &got), 0);
}

Test(fields, splits_on_whitespace) {
  char *fields[MAX_FIELDS];
  copy_line("a  b\tc");
  cr_assert_eq(split_fields(line, fields), 3);
  cr_assert_str_eq(fields[2], "c");
}

Test(fields, trims_both_ends) {
  copy_line("  padded  ");
  cr_assert_str_eq(trim(line), "padded");
}
