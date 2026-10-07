#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <stdint.h>
#include <cmocka.h>

#include "pricing.h"

static void test_takes_the_percentage_off(void **state) {
  (void)state;
  assert_int_equal(apply_discount(200, 10), 180);
}

static void test_a_full_discount_is_free(void **state) {
  (void)state;
  assert_int_equal(apply_discount(200, 100), 0);
  assert_int_equal(apply_discount(200, 150), 0);
}

static void test_no_discount_leaves_the_total(void **state) {
  (void)state;
  assert_int_equal(apply_discount(200, 0), 200);
  assert_int_equal(apply_discount(200, -5), 200);
}

static void test_bulk_discounts(void **state) {
  (void)state;
  assert_int_equal(discount_for_quantity(1), 0);
  assert_int_equal(discount_for_quantity(10), 5);
  assert_int_equal(discount_for_quantity(100), 15);
}

static void test_tax_rounds_half_up(void **state) {
  (void)state;
  assert_int_equal(tax_for(1000, 725), 73);
  assert_int_equal(tax_for(0, 725), 0);
}

static void test_tax_rate_by_region(void **state) {
  (void)state;
  assert_int_equal(tax_rate("CA"), 725);
  assert_int_equal(tax_rate("OR"), 0);
  assert_int_equal(tax_rate("TX"), 500);
  assert_int_equal(tax_rate(NULL), 0);
}

int main(void) {
  const struct CMUnitTest discount_tests[] = {
    cmocka_unit_test(test_takes_the_percentage_off),
    cmocka_unit_test(test_a_full_discount_is_free),
    cmocka_unit_test(test_no_discount_leaves_the_total),
    cmocka_unit_test(test_bulk_discounts),
    cmocka_unit_test(test_tax_rounds_half_up),
    cmocka_unit_test(test_tax_rate_by_region),
  };
  return cmocka_run_group_tests(discount_tests, NULL, NULL);
}
