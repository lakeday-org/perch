#include <gtest/gtest.h>

#include <string>
#include <vector>

#include "ledger/stats.hpp"

TEST(RunningAverage, TracksTheMeanAndTheLargest) {
  ledger::RunningAverage<long> average;
  for (long value : {40L, 10L, 70L}) average.add(value);
  EXPECT_EQ(average.count(), 3u);
  EXPECT_DOUBLE_EQ(average.mean(), 40.0);
  EXPECT_EQ(average.max(), 70L);
}

TEST(RunningAverage, HasNoLargestWhenEmpty) {
  ledger::RunningAverage<int> average;
  EXPECT_DOUBLE_EQ(average.mean(), 0.0);
  EXPECT_FALSE(average.max().has_value());
}

TEST(LargestBy, FindsTheFirstOfTheLargest) {
  const std::vector<std::string> names{"cash", "receivable", "payable", "equipment!"};
  const std::string* longest = ledger::largest_by(names, [](const std::string& name) { return name.size(); });
  ASSERT_NE(longest, nullptr);
  EXPECT_EQ(*longest, "receivable");
}
