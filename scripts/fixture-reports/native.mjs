/**
 * C and C++ fixtures: CMake builds the tests with gcov instrumentation, the test binary writes JUnit, and gcovr writes Cobertura
 * from the gcov data that run left behind. One app per framework: GoogleTest, Catch2 v3 and doctest.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { report, run, works } from './common.mjs';

/** What a CI runner would build a C++ fixture with: every source but main.cpp, every test, the framework, gcov instrumentation. */
const cmakeLists = ({ find, link }) => `cmake_minimum_required(VERSION 3.16)
project(order_service_cpp CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
${find}
add_compile_options(--coverage -O0 -g)
add_link_options(--coverage)
file(GLOB tests test/*_test.cpp)
add_executable(order_tests src/cart.cpp src/checkout.cpp \${tests})
target_include_directories(order_tests PRIVATE src)
target_link_libraries(order_tests ${link})
`;

/**
 * Each framework: how CMake finds it, what the tests link, and the arguments that make the test binary write JUnit to a file.
 * GoogleTest links gtest_main. Catch2 v3 links Catch2WithMain. doctest is one header, and a test file defines its main.
 * Catch2's JUnit reporter writes no testcase for a test case that made no assertion; `--warn NoAssertions` makes it write one.
 */
const frameworks = {
  googletest: { name: 'GoogleTest', find: 'find_package(GTest REQUIRED)', link: 'GTest::gtest_main', junit: file => [`--gtest_output=xml:${file}`] },
  catch2: { name: 'Catch2 3', find: 'find_package(Catch2 3 REQUIRED)', link: 'Catch2::Catch2WithMain', junit: file => ['--warn', 'NoAssertions', '--reporter', `junit::out=${file}`] },
  doctest: { name: 'doctest', find: 'find_package(doctest REQUIRED)', link: 'doctest::doctest', junit: file => ['--reporters=junit', `--out=${file}`] },
};

/** What is missing to build with `framework`: CMake, the framework as CMake's find_package finds it, and gcovr. */
async function missing(scratch, framework) {
  const { name, find } = frameworks[framework];
  const absent = works('gcovr', ['--version']) ? [] : ['gcovr'];
  if (!works('cmake', ['--version'])) return ['CMake', name, ...absent];
  const probe = join(scratch, `${framework}-probe`);
  await mkdir(probe, { recursive: true });
  await writeFile(join(probe, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.16)\nproject(probe CXX)\n${find}\n`);
  if (!works('cmake', ['-S', probe, '-B', join(probe, 'build')])) absent.unshift(`${name} (CMake ${find} failed)`);
  return absent;
}

/** Builds and runs the tests once, then has gcovr read the gcov data the run wrote. */
async function generate(copy, framework) {
  const spec = frameworks[framework];
  await writeFile(join(copy.real, 'CMakeLists.txt'), cmakeLists(spec));
  run('cmake', ['-S', '.', '-B', 'build', '-DCMAKE_BUILD_TYPE=Debug'], { cwd: copy.real });
  run('cmake', ['--build', 'build'], { cwd: copy.real });
  const junit = join(copy.out, 'junit.xml');
  run(join(copy.real, 'build/order_tests'), spec.junit(junit), { cwd: copy.real, tests: true });
  const cobertura = join(copy.out, 'cobertura.xml');
  run('gcovr', ['--root', '.', '--filter', 'src/', '--cobertura', cobertura, 'build'], { cwd: copy.real });
  return { [`${framework}/junit.xml`]: await report(copy, junit), [`${framework}/cobertura.xml`]: await report(copy, cobertura) };
}

const app = framework => ({ missing: scratch => missing(scratch, framework), generate: copy => generate(copy, framework) });

export const apps = {
  'order-service-cpp': app('googletest'),
  'order-service-cpp-catch2': app('catch2'),
  'order-service-cpp-doctest': app('doctest'),
};
