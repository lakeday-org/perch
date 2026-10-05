#ifndef FILTER_H
#define FILTER_H

#include <stddef.h>
#include <stdint.h>

#define FILTER_WINDOW 4

/* A moving average over the last FILTER_WINDOW samples. */
typedef struct {
  int32_t samples[FILTER_WINDOW];
  size_t next;
  size_t filled;
} filter;

void filter_init(filter *f);
void filter_add(filter *f, int32_t sample);
/* The mean of the samples so far; zero before any. */
int32_t filter_mean(const filter *f);
/* A reading held within the sensor's range. */
int32_t clamp_reading(int32_t reading, int32_t low, int32_t high);

#endif
