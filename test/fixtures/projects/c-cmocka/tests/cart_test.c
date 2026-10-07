#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdlib.h>
#include <cmocka.h>

#include "pricing.h"

static int setup_cart(void **state) {
  cart *c = malloc(sizeof *c);
  if (c == NULL) return -1;
  cart_init(c, "CA");
  *state = c;
  return 0;
}

static int teardown_cart(void **state) {
  free(*state);
  return 0;
}

static void test_an_empty_cart_costs_nothing(void **state) {
  cart *c = *state;
  assert_int_equal(cart_subtotal(c), 0);
  assert_int_equal(cart_total(c), 0);
}

static void test_subtotal_applies_bulk_discounts(void **state) {
  cart *c = *state;
  assert_int_equal(cart_add(c, "widget", 100, 10), 0);
  assert_int_equal(cart_subtotal(c), 950);
}

static void test_total_adds_the_regions_tax(void **state) {
  cart *c = *state;
  assert_int_equal(cart_add(c, "widget", 1000, 1), 0);
  assert_int_equal(cart_total(c), 1073);
}

static void test_rejects_a_zero_quantity(void **state) {
  cart *c = *state;
  assert_int_not_equal(cart_add(c, "widget", 100, 0), 0);
}

static void test_the_cart_fills_up(void **state) {
  cart *c = *state;
  for (int i = 0; i < CART_MAX_ITEMS; i++) assert_int_equal(cart_add(c, "widget", 1, 1), 0);
  assert_int_not_equal(cart_add(c, "one more", 1, 1), 0);
}

int main(void) {
  const struct CMUnitTest cart_tests[] = {
    cmocka_unit_test_setup_teardown(test_an_empty_cart_costs_nothing, setup_cart, teardown_cart),
    cmocka_unit_test_setup_teardown(test_subtotal_applies_bulk_discounts, setup_cart, teardown_cart),
    cmocka_unit_test_setup_teardown(test_total_adds_the_regions_tax, setup_cart, teardown_cart),
    cmocka_unit_test_setup_teardown(test_rejects_a_zero_quantity, setup_cart, teardown_cart),
    cmocka_unit_test_setup_teardown(test_the_cart_fills_up, setup_cart, teardown_cart),
  };
  return cmocka_run_group_tests_name("cart", cart_tests, NULL, NULL);
}
