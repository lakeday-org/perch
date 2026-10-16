#include "ring.h"

void ring_init(ring *r) {
  r->head = 0;
  r->tail = 0;
  r->count = 0;
}

bool ring_is_full(const ring *r) {
  return r->count >= RING_CAPACITY;
}

bool ring_push(ring *r, uint8_t value) {
  if (ring_is_full(r)) return false;
  r->items[r->tail] = value;
  r->tail = (r->tail + 1) % RING_CAPACITY;
  r->count++;
  return true;
}

bool ring_pop(ring *r, uint8_t *value) {
  if (r->count == 0) return false;
  *value = r->items[r->head];
  r->head = (r->head + 1) % RING_CAPACITY;
  r->count--;
  return true;
}

size_t ring_count(const ring *r) {
  return r->count;
}
