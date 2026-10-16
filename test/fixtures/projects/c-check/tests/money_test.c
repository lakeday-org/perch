#include <check.h>

#include "ledger.h"
#include "suites.h"

START_TEST(adds_amounts_in_one_currency)
{
  money sum;
  ck_assert_int_eq(money_add(money_new(150, USD), money_new(250, USD), &sum), 0);
  ck_assert_int_eq(sum.minor, 400);
}
END_TEST

START_TEST(refuses_to_add_across_currencies)
{
  money sum;
  ck_assert_int_ne(money_add(money_new(1, USD), money_new(1, EUR), &sum), 0);
}
END_TEST

START_TEST(allocates_the_remainder_to_the_first_parts)
{
  money parts[3];
  ck_assert_int_eq(money_allocate(money_new(100, USD), 3, parts), 0);
  ck_assert_int_eq(parts[0].minor, 34);
  ck_assert_int_eq(parts[1].minor, 33);
  ck_assert_int_eq(parts[2].minor, 33);
}
END_TEST

START_TEST(rejects_allocation_into_zero_parts)
{
  money parts[1];
  ck_assert_int_ne(money_allocate(money_new(100, USD), 0, parts), 0);
}
END_TEST

START_TEST(yen_has_no_minor_units)
{
  ck_assert_int_eq(minor_units(JPY), 0);
  ck_assert_int_eq(minor_units(USD), 2);
}
END_TEST

START_TEST(names_each_currency)
{
  ck_assert_str_eq(currency_code(EUR), "EUR");
  ck_assert_str_eq(currency_code(JPY), "JPY");
}
END_TEST

Suite *money_suite(void)
{
  Suite *s = suite_create("Money");

  TCase *tc_arith = tcase_create("Arithmetic");
  tcase_add_test(tc_arith, adds_amounts_in_one_currency);
  tcase_add_test(tc_arith, refuses_to_add_across_currencies);
  tcase_add_test(tc_arith, allocates_the_remainder_to_the_first_parts);
  tcase_add_test(tc_arith, rejects_allocation_into_zero_parts);
  suite_add_tcase(s, tc_arith);

  TCase *tc_units = tcase_create("Units");
  tcase_add_test(tc_units, yen_has_no_minor_units);
  tcase_add_test(tc_units, names_each_currency);
  suite_add_tcase(s, tc_units);

  return s;
}
