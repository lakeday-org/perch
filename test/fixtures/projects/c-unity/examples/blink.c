/* Reads fake sensor samples, smooths them, and frames each reading with a CRC for the wire. */
#include <stdio.h>

#include "crc.h"
#include "filter.h"
#include "ring.h"

int main(void) {
  filter smoothing;
  ring outgoing;
  filter_init(&smoothing);
  ring_init(&outgoing);
  for (int32_t sample = 0; sample < 16; sample++) {
    filter_add(&smoothing, clamp_reading(sample * 7, 0, 100));
    uint8_t frame[2] = { (uint8_t)filter_mean(&smoothing), 0 };
    frame[1] = crc8(frame, 1);
    ring_push(&outgoing, frame[1]);
  }
  printf("%zu frames queued\n", ring_count(&outgoing));
  return 0;
}
