#include <criterion/criterion.h>
#include <criterion/parameterized.h>

#include "parse.h"

static long parsed;

static void reset(void) {
  parsed = -1;
}

TestSuite(amount, .init = reset);

Test(amount, parses_dollars_and_cents) {
  cr_assert_eq(parse_amount("12.34", &parsed), 0);
  cr_assert_eq(parsed, 1234);
}

Test(amount, parses_a_whole_number) {
  cr_assert_eq(parse_amount("7", &parsed), 0);
  cr_assert_eq(parsed, 700);
}

Test(amount, parses_a_negative_amount) {
  cr_assert_eq(parse_amount("-0.50", &parsed), 0);
  cr_assert_eq(parsed, -50);
}

Test(amount, rejects_three_decimal_places) {
  cr_assert_neq(parse_amount("1.234", &parsed), 0);
  cr_assert_eq(parsed, -1);
}

Test(amount, rejects_an_empty_string, .description = "nothing to parse") {
  cr_assert_neq(parse_amount("", &parsed), 0);
}

ParameterizedTestParameters(amount, rejects_a_bad_sign) {
  static long positions[] = { 0, 1, 2 };
  return cr_make_param_array(long, positions, sizeof positions / sizeof positions[0]);
}

ParameterizedTest(long *position, amount, rejects_a_bad_sign) {
  char text[] = "1-2";
  text[*position] = '-';
  text[2] = '2';
  cr_assert_neq(parse_amount(text, &parsed), 0);
}

Test(format, formats_cents_with_two_digits) {
  char buffer[32];
  format_amount(1234, buffer, sizeof buffer);
  cr_assert_str_eq(buffer, "12.34");
}

Test(format, formats_a_negative_amount) {
  char buffer[32];
  format_amount(-5, buffer, sizeof buffer);
  cr_assert_str_eq(buffer, "-0.05");
}
