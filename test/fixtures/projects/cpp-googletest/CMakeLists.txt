cmake_minimum_required(VERSION 3.20)
project(ledger VERSION 0.4.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(LEDGER_BUILD_TESTS "Build the unit tests" ON)
option(LEDGER_BUILD_TOOLS "Build ledger-import" OFF)
option(LEDGER_BUILD_BENCH "Build the posting benchmark" OFF)
option(LEDGER_COVERAGE "Instrument the library and tests for gcov" OFF)

if(LEDGER_COVERAGE)
  add_compile_options(--coverage -O0 -g)
  add_link_options(--coverage)
endif()

add_library(ledger
  src/account.cpp
  src/currency.cpp
  src/ledger.cpp
  src/money.cpp
  src/parse.cpp
  src/report.cpp
  src/transaction.cpp
)
add_library(ledger::ledger ALIAS ledger)
target_include_directories(ledger PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)
target_compile_options(ledger PRIVATE -Wall -Wextra -Wpedantic)

if(LEDGER_BUILD_TESTS)
  enable_testing()
  find_package(GTest REQUIRED)
  add_executable(ledger_tests
    tests/currency_test.cpp
    tests/ledger_test.cpp
    tests/money_test.cpp
    tests/parse_test.cpp
    tests/stats_test.cpp
    tests/transaction_test.cpp
  )
  target_link_libraries(ledger_tests PRIVATE ledger::ledger GTest::gtest_main)
  include(GoogleTest)
  gtest_discover_tests(ledger_tests DISCOVERY_MODE PRE_TEST)
endif()

if(LEDGER_BUILD_TOOLS)
  add_executable(ledger-import tools/ledger_import.cpp)
  target_link_libraries(ledger-import PRIVATE ledger::ledger)
endif()

if(LEDGER_BUILD_BENCH)
  add_executable(ledger_bench bench/ledger_bench.cpp)
  target_link_libraries(ledger_bench PRIVATE ledger::ledger)
endif()

include(GNUInstallDirs)
install(TARGETS ledger EXPORT ledgerTargets)
install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
