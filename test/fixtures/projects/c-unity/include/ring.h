#ifndef RING_H
#define RING_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define RING_CAPACITY 8

/* A fixed-capacity queue of bytes. */
typedef struct {
  uint8_t items[RING_CAPACITY];
  size_t head;
  size_t tail;
  size_t count;
} ring;

void ring_init(ring *r);
/* False when the ring is full. */
bool ring_push(ring *r, uint8_t value);
/* False when the ring is empty. */
bool ring_pop(ring *r, uint8_t *value);
size_t ring_count(const ring *r);
bool ring_is_full(const ring *r);

#endif
