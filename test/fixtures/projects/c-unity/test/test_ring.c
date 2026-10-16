#include "unity.h"

#include "ring.h"

static ring buffer;

void setUp(void) {
  ring_init(&buffer);
}

void tearDown(void) {}

void test_a_new_ring_is_empty(void) {
  TEST_ASSERT_EQUAL_size_t(0, ring_count(&buffer));
  TEST_ASSERT_FALSE(ring_is_full(&buffer));
}

void test_push_then_pop_returns_the_value(void) {
  TEST_ASSERT_TRUE(ring_push(&buffer, 42));
  uint8_t value = 0;
  TEST_ASSERT_TRUE(ring_pop(&buffer, &value));
  TEST_ASSERT_EQUAL_UINT8(42, value);
}

void test_pop_on_empty_fails(void) {
  uint8_t value = 0;
  TEST_ASSERT_FALSE(ring_pop(&buffer, &value));
}

void test_push_fails_when_full(void) {
  for (uint8_t i = 0; i < RING_CAPACITY; i++) TEST_ASSERT_TRUE(ring_push(&buffer, i));
  TEST_ASSERT_TRUE(ring_is_full(&buffer));
  TEST_ASSERT_FALSE(ring_push(&buffer, 99));
}

void test_wraps_around(void) {
  uint8_t value = 0;
  for (uint8_t i = 0; i < RING_CAPACITY; i++) ring_push(&buffer, i);
  ring_pop(&buffer, &value);
  ring_pop(&buffer, &value);
  TEST_ASSERT_TRUE(ring_push(&buffer, 100));
  TEST_ASSERT_TRUE(ring_push(&buffer, 101));
  TEST_ASSERT_EQUAL_size_t(RING_CAPACITY, ring_count(&buffer));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_a_new_ring_is_empty);
  RUN_TEST(test_push_then_pop_returns_the_value);
  RUN_TEST(test_pop_on_empty_fails);
  RUN_TEST(test_push_fails_when_full);
  RUN_TEST(test_wraps_around);
  return UNITY_END();
}
