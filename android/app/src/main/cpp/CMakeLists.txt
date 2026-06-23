# NDK build of the Cribbage Zero native actor (libczactor.so), driven by Gradle externalNativeBuild.
# The engine is the same header-only C++ core the PC learner uses (core/*.h); on Android the actor only
# SELF-PLAYS and uploads samples — HTTP is bridged to Java (HttpURLConnection) via JNI, so no libcurl here.
cmake_minimum_required(VERSION 3.22.1)
project(czactor LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# the header-only engine + vendored nlohmann/json live at the repo root, 5 dirs up from this file
# (cpp -> main -> src -> app -> android -> repo root).
get_filename_component(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../.." ABSOLUTE)

add_library(czactor SHARED cz_jni.cpp)
target_include_directories(czactor PRIVATE ${REPO_ROOT}/core ${REPO_ROOT}/third_party)

# Match the PC build's safe vectorization flags (reductions vectorize WITHOUT -ffinite-math-only, so NaN/Inf
# stay well-defined). No -march=native: the NDK targets a generic arm64-v8a baseline.
target_compile_options(czactor PRIVATE
  -O3 -funroll-loops -fassociative-math -fno-signed-zeros -fno-trapping-math -fno-math-errno)

# android log only (no libcurl, no extra deps)
find_library(log-lib log)
target_link_libraries(czactor PRIVATE ${log-lib})
