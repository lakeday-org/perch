// Times picking from a SKU spread over many bins.
#include <catch2/benchmark/catch_benchmark.hpp>
#include <catch2/catch_test_macros.hpp>

#include "stockroom/inventory.hpp"

TEST_CASE("pick from 500 bins") {
  const stockroom::Sku bolts("BLT-0042");
  BENCHMARK_ADVANCED("pick")(Catch::Benchmark::Chronometer meter) {
    stockroom::Inventory inventory;
    for (int i = 0; i < 500; ++i) inventory.receive(bolts, 2, stockroom::BinLocation{static_cast<char>('A' + i % 26), 1 + i % 20, 1 + i % 50});
    inventory.reserve(bolts, 900);
    meter.measure([&] { return inventory.pick(bolts, 900, stockroom::BinLocation{'A', 1, 1}); });
  };
}
