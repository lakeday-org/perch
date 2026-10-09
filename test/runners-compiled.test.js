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

const installed = command => { try { execFileSync(command, ['--version'], { stdio: 'ignore' }); return true; } catch { try { execFileSync(command, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } } };

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
