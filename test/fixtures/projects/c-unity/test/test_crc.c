#include "unity.h"

#include "crc.h"

void setUp(void) {}

void tearDown(void) {}

void test_crc_of_nothing_is_zero(void) {
  TEST_ASSERT_EQUAL_UINT8(0, crc8(NULL, 0));
}

void test_crc_of_a_known_vector(void) {
  const uint8_t data[] = { '1', '2', '3', '4', '5', '6', '7', '8', '9' };
  TEST_ASSERT_EQUAL_UINT8(0xF4, crc8(data, sizeof data));
}

void test_check_accepts_a_good_frame(void) {
  uint8_t frame[] = { 0x01, 0x02, 0x03, 0x00 };
  frame[3] = crc8(frame, 3);
  TEST_ASSERT_TRUE(crc8_check(frame, sizeof frame));
}

void test_check_rejects_a_corrupted_frame(void) {
  uint8_t frame[] = { 0x01, 0x02, 0x03, 0x00 };
  frame[3] = crc8(frame, 3);
  frame[1] ^= 0x10;
  TEST_ASSERT_FALSE(crc8_check(frame, sizeof frame));
}

void test_check_needs_a_payload_and_a_crc(void) {
  uint8_t frame[] = { 0x00 };
  TEST_ASSERT_FALSE(crc8_check(frame, 1));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_crc_of_nothing_is_zero);
  RUN_TEST(test_crc_of_a_known_vector);
  RUN_TEST(test_check_accepts_a_good_frame);
  RUN_TEST(test_check_rejects_a_corrupted_frame);
  RUN_TEST(test_check_needs_a_payload_and_a_crc);
  return UNITY_END();
}
