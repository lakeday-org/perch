#include "filter.h"

void filter_init(filter *f) {
  f->next = 0;
  f->filled = 0;
  for (size_t i = 0; i < FILTER_WINDOW; i++) f->samples[i] = 0;
}

void filter_add(filter *f, int32_t sample) {
  f->samples[f->next] = sample;
  f->next = (f->next + 1) % FILTER_WINDOW;
  if (f->filled < FILTER_WINDOW) f->filled++;
}

int32_t filter_mean(const filter *f) {
  if (f->filled == 0) return 0;
  int32_t sum = 0;
  for (size_t i = 0; i < f->filled; i++) sum += f->samples[i];
  return sum / (int32_t)f->filled;
}

int32_t clamp_reading(int32_t reading, int32_t low, int32_t high) {
  if (reading < low) return low;
  if (reading > high) return high;
  return reading;
}
