cmake_minimum_required(VERSION 3.20)
project(stockroom VERSION 1.2.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(STOCKROOM_BUILD_TESTS "Build the unit tests" ON)
option(STOCKROOM_BUILD_TOOLS "Build stockroom-count" OFF)
option(STOCKROOM_BUILD_BENCH "Build the picking benchmark" OFF)
option(STOCKROOM_COVERAGE "Instrument the library and tests for gcov" OFF)

if(STOCKROOM_COVERAGE)
  add_compile_options(--coverage -O0 -g)
  add_link_options(--coverage)
endif()

add_library(stockroom
  src/audit.cpp
  src/csv.cpp
  src/inventory.cpp
  src/location.cpp
  src/reorder.cpp
  src/sku.cpp
)
add_library(stockroom::stockroom ALIAS stockroom)
target_include_directories(stockroom PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)
target_compile_options(stockroom PRIVATE -Wall -Wextra)

if(STOCKROOM_BUILD_TESTS)
  enable_testing()
  find_package(Catch2 3 REQUIRED)
  add_executable(stockroom_tests
    tests/csv_test.cpp
    tests/inventory_test.cpp
    tests/location_test.cpp
    tests/reorder_test.cpp
    tests/ring_buffer_test.cpp
    tests/sku_test.cpp
  )
  target_link_libraries(stockroom_tests PRIVATE stockroom::stockroom Catch2::Catch2WithMain)
  include(Catch)
  catch_discover_tests(stockroom_tests DISCOVERY_MODE PRE_TEST)
endif()

if(STOCKROOM_BUILD_TOOLS)
  add_executable(stockroom-count tools/stockroom_count.cpp)
  target_link_libraries(stockroom-count PRIVATE stockroom::stockroom)
endif()

if(STOCKROOM_BUILD_BENCH)
  find_package(Catch2 3 REQUIRED)
  add_executable(stockroom_bench bench/pick_bench.cpp)
  target_link_libraries(stockroom_bench PRIVATE stockroom::stockroom Catch2::Catch2WithMain)
endif()
