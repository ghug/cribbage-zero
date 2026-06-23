cmake_minimum_required(VERSION 3.16)
project(cribbage_zero_core CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
add_compile_options(-O2 -Wall -Wextra)

enable_testing()

# header-only core for now (rng/cards/scoring/net). Tests link nothing extra.
add_executable(test_scoring tests/test_scoring.cpp)
target_include_directories(test_scoring PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME scoring COMMAND test_scoring)

add_executable(test_net tests/test_net.cpp)
target_include_directories(test_net PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME net COMMAND test_net)

add_executable(test_selfplay tests/test_selfplay.cpp)
target_include_directories(test_selfplay PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME selfplay COMMAND test_selfplay)
