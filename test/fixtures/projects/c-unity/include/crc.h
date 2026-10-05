#ifndef CRC_H
#define CRC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* CRC-8 with the polynomial 0x07 over the bytes. */
uint8_t crc8(const uint8_t *data, size_t length);
/* Whether a frame's last byte is the CRC-8 of the bytes before it. */
bool crc8_check(const uint8_t *frame, size_t length);

#endif
