cmake_minimum_required(VERSION 3.20)
project(pricing VERSION 0.2.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

option(PRICING_BUILD_TESTS "Build the unit tests" ON)
option(PRICING_BUILD_BENCH "Build the cart benchmark" OFF)

add_library(pricing src/discount.c src/tax.c src/cart.c)
target_include_directories(pricing PUBLIC include)
target_compile_options(pricing PRIVATE -Wall -Wextra)

if(PRICING_BUILD_TESTS)
  enable_testing()
  find_package(cmocka REQUIRED)
  foreach(name discount cart)
    add_executable(${name}_test tests/${name}_test.c)
    target_link_libraries(${name}_test PRIVATE pricing cmocka::cmocka)
    add_test(NAME ${name} COMMAND ${name}_test)
  endforeach()
endif()

if(PRICING_BUILD_BENCH)
  add_executable(cart_bench bench/cart_bench.c)
  target_link_libraries(cart_bench PRIVATE pricing)
endif()
