"""Hits per second for each algorithm against in-memory storage: python benchmarks/bench_algorithms.py"""
import timeit

from governor import FixedWindow, SlidingWindowCounter, TokenBucket


def bench(limiter, keys=1000, number=200_000):
    names = [f"user-{index}" for index in range(keys)]
    counter = iter(range(number * 2))

    def one():
        limiter.hit(names[next(counter) % keys])

    seconds = timeit.timeit(one, number=number)
    return number / seconds


if __name__ == "__main__":
    for limiter in (TokenBucket("1000/second"), FixedWindow("1000/second"), SlidingWindowCounter("1000/second")):
        print(f"{limiter.name:<16}{bench(limiter):>12,.0f} hits/s")
