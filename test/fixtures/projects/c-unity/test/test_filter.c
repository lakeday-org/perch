#include "unity.h"

#include "filter.h"

static filter smoothing;

void setUp(void) {
  filter_init(&smoothing);
}

void tearDown(void) {}

void test_mean_of_nothing_is_zero(void) {
  TEST_ASSERT_EQUAL_INT32(0, filter_mean(&smoothing));
}

void test_mean_of_a_partial_window(void) {
  filter_add(&smoothing, 10);
  filter_add(&smoothing, 20);
  TEST_ASSERT_EQUAL_INT32(15, filter_mean(&smoothing));
}

void test_mean_forgets_the_oldest_sample(void) {
  for (int32_t sample = 1; sample <= FILTER_WINDOW + 1; sample++) filter_add(&smoothing, sample);
  TEST_ASSERT_EQUAL_INT32(3, filter_mean(&smoothing));
}

void test_clamp_keeps_a_reading_in_range(void) {
  TEST_ASSERT_EQUAL_INT32(0, clamp_reading(-5, 0, 100));
  TEST_ASSERT_EQUAL_INT32(100, clamp_reading(500, 0, 100));
  TEST_ASSERT_EQUAL_INT32(42, clamp_reading(42, 0, 100));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_mean_of_nothing_is_zero);
  RUN_TEST(test_mean_of_a_partial_window);
  RUN_TEST(test_mean_forgets_the_oldest_sample);
  RUN_TEST(test_clamp_keeps_a_reading_in_range);
  return UNITY_END();
}
