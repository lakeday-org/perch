import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { coverageRepository } from '../src/coverage.js';
import { TOKEN_LIMITS } from '../src/tokens.js';
import { initRepo } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

const installed = command => { for (const args of [['--version'], ['version'], ['-version'], ['--script-version']]) { try { execFileSync(command, args, { stdio: 'ignore' }); return true; } catch { /* the next way of asking */ } } return false; };

const model = () => ({ id: 'scripted', limits: TOKEN_LIMITS, async ask(state, questions) {
  return { model: 'scripted', answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0.9 }])), usage: { input_tokens: 1, output_tokens: 0 } };
} });

async function repository(files, ignore = '') {
  const root = await mkdtemp(join(tmpdir(), 'perch-compiled-'));
  cleanups.push(root);
  for (const [path, text] of Object.entries({ ...files, '.gitignore': ignore })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await initRepo(root);
  return root;
}

const run = async root => coverageRepository({ root, revision: await revision(root), out: join(root, '.perch'), analyzer, systemOne: model(), parallel: 2 });
const mutant = (report, method, kind) => report.methods.find(item => item.id.endsWith(`::${method}`)).mutants.find(item => item.kind === kind);

describe('running compiled tests', () => {
  it.skipIf(!installed('cargo'))('builds a crate once with every mutant switched in, and knows which test reaches which', async () => {
    const root = await repository({
      'Cargo.toml': '[package]\nname = "shop"\nversion = "0.0.0"\nedition = "2021"\n',
      'src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\npub fn scale(a: i32, factor: i32) -> i32 {\n    a * factor\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds() {\n        assert_eq!(add(2, 3), 5);\n    }\n\n    #[test]\n    fn scales_without_checking() {\n        scale(2, 3);\n    }\n}\n',
    }, 'target\n');
    const report = await run(root);
    expect(report.measured).toMatchObject({ runner: 'cargo', invalid: 0, unmatched_tests: 0 });
    expect(mutant(report, 'add', 'arithmetic')).toMatchObject({ killed: true, killed_by: ['src/lib.rs::adds'], asked: ['src/lib.rs::adds'] });
    expect(mutant(report, 'scale', 'arithmetic')).toMatchObject({ killed: false, asked: ['src/lib.rs::scales_without_checking'] });
    expect(report.findings.some(finding => finding.kind === 'checks_nothing' && finding.unit === 'src/lib.rs::scales_without_checking')).toBe(true);
  }, 300000);

  it.skipIf(!installed('go'))('builds each mutant into a copy of the module, and runs each test alone for what it covers', async () => {
    const root = await repository({
      'go.mod': 'module example.com/shop\n\ngo 1.22\n',
      'calc/calc.go': 'package calc\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n\nfunc Scale(a, factor int) int {\n\treturn a * factor\n}\n',
      'calc/calc_test.go': 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("add")\n\t}\n}\n\nfunc TestScaleRuns(t *testing.T) {\n\tScale(2, 3)\n}\n',
    });
    const report = await run(root);
    expect(report.measured).toMatchObject({ runner: 'go', invalid: 0, unmatched_tests: 0 });
    expect(mutant(report, 'Add', 'arithmetic')).toMatchObject({ killed: true, killed_by: ['calc/calc_test.go::TestAdd'], asked: ['calc/calc_test.go::TestAdd'] });
    expect(mutant(report, 'Scale', 'arithmetic')).toMatchObject({ killed: false, asked: ['calc/calc_test.go::TestScaleRuns'] });
  }, 300000);

  const JAVA = 'package shop;\n\npublic final class Calc {\n    public static int add(int a, int b) {\n        return a + b;\n    }\n\n    public static int scale(int a, int factor) {\n        int total = 0;\n        for (int at = 0; at < factor; at++) {\n            total += a;\n        }\n        return total;\n    }\n}\n';
  const JUNIT5 = 'package shop;\n\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nimport org.junit.jupiter.api.Test;\n\nclass CalcTest {\n    @Test\n    void adds() {\n        assertEquals(5, Calc.add(2, 3));\n    }\n\n    @Test\n    void scalesWithoutChecking() {\n        Calc.scale(2, 3);\n    }\n}\n';
  const expectJvm = (report, path, test) => {
    expect(report.measured).toMatchObject({ runner: 'jvm', unmatched_tests: 0 });
    expect(mutant(report, 'Calc.add', 'arithmetic')).toMatchObject({ killed: true, killed_by: [`${path}::${test('adds')}`] });
    // The for loop's `at++`, a place only a statement goes, is switched as `at += 1`, and runs: as `at--` it never ends, which
    // its time limit catches.
    expect(mutant(report, 'Calc.scale', 'update')).toMatchObject({ killed: true, timeout: true });
    expect(report.findings.some(finding => finding.kind === 'checks_nothing' && finding.unit === `${path}::${test('scalesWithoutChecking')}`)).toBe(true);
  };

  it.skipIf(!installed('java') || !installed('gradle'))('builds a Gradle project once and runs each mutant in a warm JVM through JUnit 5', async () => {
    const root = await repository({
      'settings.gradle': "rootProject.name = 'shop'\n",
      'build.gradle': "plugins { id 'java' }\nrepositories { mavenCentral() }\ndependencies {\n  testImplementation platform('org.junit:junit-bom:5.14.4')\n  testImplementation 'org.junit.jupiter:junit-jupiter'\n  testRuntimeOnly 'org.junit.platform:junit-platform-launcher'\n}\ntest { useJUnitPlatform() }\n",
      'src/main/java/shop/Calc.java': JAVA,
      'src/test/java/shop/CalcTest.java': JUNIT5,
    }, 'build/\n.gradle/\n');
    expectJvm(await run(root), 'src/test/java/shop/CalcTest.java', name => `CalcTest.${name}`);
  }, 600000);

  it.skipIf(!installed('java') || !installed('mvn'))('builds a Maven project once and runs JUnit 4 through its own runner', async () => {
    const root = await repository({
      'pom.xml': '<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>shop</groupId>\n  <artifactId>shop</artifactId>\n  <version>1.0</version>\n  <properties>\n    <maven.compiler.release>17</maven.compiler.release>\n    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>\n  </properties>\n  <dependencies>\n    <dependency>\n      <groupId>junit</groupId>\n      <artifactId>junit</artifactId>\n      <version>4.13.2</version>\n      <scope>test</scope>\n    </dependency>\n  </dependencies>\n</project>\n',
      'src/main/java/shop/Calc.java': JAVA,
      'src/test/java/shop/CalcTest.java': 'package shop;\n\nimport static org.junit.Assert.assertEquals;\n\nimport org.junit.Test;\n\npublic class CalcTest {\n    @Test\n    public void adds() {\n        assertEquals(5, Calc.add(2, 3));\n    }\n\n    @Test\n    public void scalesWithoutChecking() {\n        Calc.scale(2, 3);\n    }\n}\n',
    }, 'target/\n');
    expectJvm(await run(root), 'src/test/java/shop/CalcTest.java', name => `CalcTest.${name}`);
  }, 600000);

  it.skipIf(!installed('java') || !installed('gradle'))('runs Kotlin, its choices written as if-expressions and its test names in backticks', async () => {
    const root = await repository({
      'settings.gradle.kts': 'rootProject.name = "shop"\n',
      'build.gradle.kts': 'plugins { kotlin("jvm") version "2.2.20" }\nrepositories { mavenCentral() }\ndependencies {\n  testImplementation(platform("org.junit:junit-bom:5.14.4"))\n  testImplementation("org.junit.jupiter:junit-jupiter")\n  testRuntimeOnly("org.junit.platform:junit-platform-launcher")\n}\ntasks.test { useJUnitPlatform() }\n',
      'src/main/kotlin/shop/Calc.kt': 'package shop\n\nobject Calc {\n    fun add(a: Int, b: Int): Int {\n        return a + b\n    }\n}\n',
      'src/test/kotlin/shop/CalcTest.kt': 'package shop\n\nimport org.junit.jupiter.api.Assertions.assertEquals\nimport org.junit.jupiter.api.Test\n\nclass CalcTest {\n    @Test\n    fun `adds two numbers`() {\n        assertEquals(5, Calc.add(2, 3))\n    }\n}\n',
    }, 'build/\n.gradle/\n.kotlin/\n');
    const report = await run(root);
    expect(report.measured).toMatchObject({ runner: 'jvm', invalid: 0, unmatched_tests: 0 });
    expect(mutant(report, 'Calc.add', 'arithmetic')).toMatchObject({ killed: true, killed_by: ['src/test/kotlin/shop/CalcTest.kt::CalcTest.`adds two numbers`'] });
  }, 600000);

  it.skipIf(!installed('java') || !installed('sbt'))('runs Scala on sbt, a ScalaTest test by its full name', async () => {
    const root = await repository({
      'build.sbt': 'scalaVersion := "3.3.3"\nlibraryDependencies += "org.scalatest" %% "scalatest" % "3.2.18" % Test\n',
      'project/build.properties': 'sbt.version=1.9.9\n',
      'src/main/scala/shop/Calc.scala': 'package shop\n\nobject Calc {\n  def add(a: Int, b: Int): Int = {\n    a + b\n  }\n}\n',
      'src/test/scala/shop/CalcSuite.scala': 'package shop\n\nimport org.scalatest.funsuite.AnyFunSuite\n\nclass CalcSuite extends AnyFunSuite {\n  test("adds two numbers") {\n    assert(Calc.add(2, 3) == 5)\n  }\n}\n',
    }, 'target/\nproject/target/\nproject/project/\n');
    const report = await run(root);
    expect(report.measured).toMatchObject({ runner: 'jvm', invalid: 0, unmatched_tests: 0 });
    expect(mutant(report, 'Calc.add', 'arithmetic')).toMatchObject({ killed: true, killed_by: ['src/test/scala/shop/CalcSuite.scala::CalcSuite.adds two numbers'] });
  }, 600000);

  it.skipIf(!installed('dotnet'))('builds a solution once with every mutant switched in, and finds the test by its attribute', async () => {
    const root = await repository({
      'src/Shop/Shop.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>\n</Project>\n',
      'src/Shop/Calc.cs': 'namespace Shop;\n\npublic static class Calc\n{\n    public static int Add(int a, int b)\n    {\n        return a + b;\n    }\n\n    public static int Scale(int a, int factor)\n    {\n        var result = 0;\n        result += a * factor;\n        return result;\n    }\n}\n',
      'tests/Shop.Tests/Shop.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <IsPackable>false</IsPackable>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />\n    <PackageReference Include="xunit" Version="2.9.3" />\n    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.4" />\n  </ItemGroup>\n  <ItemGroup>\n    <ProjectReference Include="..\\..\\src\\Shop\\Shop.csproj" />\n  </ItemGroup>\n</Project>\n',
      'tests/Shop.Tests/CalcTests.cs': 'using Shop;\nusing Xunit;\n\nnamespace Shop.Tests;\n\npublic class CalcTests\n{\n    [Fact]\n    public void Adds() => Assert.Equal(5, Calc.Add(2, 3));\n\n    [Fact]\n    public async Task ScalesWithoutChecking()\n    {\n        await Task.Yield();\n        Calc.Scale(2, 3);\n    }\n}\n',
    }, 'bin/\nobj/\n');
    const report = await run(root);
    expect(report.measured).toMatchObject({ runner: 'dotnet', invalid: 0, unmatched_tests: 0 });
    expect(mutant(report, 'Calc.Add', 'arithmetic')).toMatchObject({ killed: true, killed_by: ['tests/Shop.Tests/CalcTests.cs::CalcTests.Adds'] });
    // The async test is found through its state machine; `+=` as a whole statement is chosen as one, and runs.
    expect(mutant(report, 'Calc.Scale', 'update')).toMatchObject({ killed: false, asked: ['tests/Shop.Tests/CalcTests.cs::CalcTests.ScalesWithoutChecking'] });
  }, 600000);
});
