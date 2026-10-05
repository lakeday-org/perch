cmake_minimum_required(VERSION 3.20)
project(throttle VERSION 0.9.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(THROTTLE_BUILD_TESTS "Build the unit tests" ON)
option(THROTTLE_BUILD_TOOLS "Build throttle-replay" OFF)
option(THROTTLE_BUILD_BENCH "Build the admission benchmark" OFF)
option(THROTTLE_COVERAGE "Instrument the library and tests for gcov" OFF)

if(THROTTLE_COVERAGE)
  add_compile_options(--coverage -O0 -g)
  add_link_options(--coverage)
endif()

add_library(throttle
  src/clock.cpp
  src/duration.cpp
  src/limiter.cpp
  src/metrics.cpp
  src/policy.cpp
  src/token_bucket.cpp
  src/window.cpp
)
add_library(throttle::throttle ALIAS throttle)
target_include_directories(throttle PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)
target_compile_options(throttle PRIVATE -Wall -Wextra)

if(THROTTLE_BUILD_TESTS)
  enable_testing()
  find_package(doctest REQUIRED)
  add_executable(throttle_tests
    tests/main.cpp
    tests/duration_test.cpp
    tests/limiter_test.cpp
    tests/lru_cache_test.cpp
    tests/policy_test.cpp
    tests/token_bucket_test.cpp
    tests/window_test.cpp
  )
  target_link_libraries(throttle_tests PRIVATE throttle::throttle doctest::doctest)
  include(doctest)
  doctest_discover_tests(throttle_tests)
endif()

if(THROTTLE_BUILD_TOOLS)
  add_executable(throttle-replay tools/replay.cpp)
  target_link_libraries(throttle-replay PRIVATE throttle::throttle)
endif()

if(THROTTLE_BUILD_BENCH)
  add_executable(throttle_bench bench/admit_bench.cpp)
  target_link_libraries(throttle_bench PRIVATE throttle::throttle)
endif()
