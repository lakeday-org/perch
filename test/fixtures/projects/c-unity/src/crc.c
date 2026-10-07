#include "crc.h"

uint8_t crc8(const uint8_t *data, size_t length) {
  uint8_t crc = 0;
  for (size_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
    }
  }
  return crc;
}

bool crc8_check(const uint8_t *frame, size_t length) {
  if (length < 2) return false;
  return crc8(frame, length - 1) == frame[length - 1];
}
