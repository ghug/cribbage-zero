cmake_minimum_required(VERSION 3.16)
project(cribbage_zero_core CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
# reassociation (needed to vectorize the FP dot-product reductions — the big matmul speedup) WITHOUT
# -ffinite-math-only, so NaN/Inf are still handled correctly (we don't assume their absence).
add_compile_options(-O3 -march=native -funroll-loops
  -fassociative-math -fno-signed-zeros -fno-trapping-math -fno-math-errno -Wall -Wextra)

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

# hard-bot + native eval (hardbot.h / eval.h) validated vs the JS reference values
add_executable(test_hardbot tests/test_hardbot.cpp)
target_include_directories(test_hardbot PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME hardbot COMMAND test_hardbot)

# anti-NaN guards: sample validation, net.finite(), clampWeights
add_executable(test_guards tests/test_guards.cpp)
target_include_directories(test_guards PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME guards COMMAND test_guards)

# vendored single-header JSON (net / sample / info serialization)
set(THIRD_PARTY ${CMAKE_CURRENT_SOURCE_DIR}/../third_party)

add_executable(test_netio tests/test_netio.cpp)
target_include_directories(test_netio PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${THIRD_PARTY})
add_test(NAME netio COMMAND test_netio)

# orchestration test (mock HTTP; no curl, needs threads for parallel self-play)
find_package(Threads REQUIRED)
add_executable(test_orchestration tests/test_orchestration.cpp)
target_include_directories(test_orchestration PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${THIRD_PARTY})
target_link_libraries(test_orchestration PRIVATE Threads::Threads)
add_test(NAME orchestration COMMAND test_orchestration)

# shared actor loop (core/actor.h) — the loop the Android native worker runs; mock-HTTP unit test
add_executable(test_actor tests/test_actor.cpp)
target_include_directories(test_actor PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${THIRD_PARTY})
target_link_libraries(test_actor PRIVATE Threads::Threads)
add_test(NAME actor COMMAND test_actor)

# libcurl-backed HTTP (PC). Optional: only when libcurl is available.
find_package(CURL)
if(CURL_FOUND)
  add_executable(test_http tests/test_http.cpp)
  target_include_directories(test_http PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${THIRD_PARTY})
  target_link_libraries(test_http PRIVATE CURL::libcurl)
  # NOT registered as a ctest — it needs network; run ./build/test_http manually.

  # the PC learner/actor CLI
  add_executable(cz_pc ${CMAKE_CURRENT_SOURCE_DIR}/../pc/main.cpp)
  target_include_directories(cz_pc PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${THIRD_PARTY})
  target_link_libraries(cz_pc PRIVATE CURL::libcurl Threads::Threads)
  message(STATUS "libcurl found: building test_http + cz_pc")
else()
  message(STATUS "libcurl NOT found: skipping test_http + cz_pc (orchestration still tests via the mock)")
endif()
