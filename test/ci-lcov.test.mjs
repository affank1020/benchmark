import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJunit, parseLcov } from "../src/core.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const workflow = () => readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("CI produces source-only LCOV and JUnit together on pushes and PRs", async () => {
  const ci = await workflow();
  assert.match(ci, /on:\s*\n\s*push:\s*\n\s*branches: \[main, "atlas\/\*\*"\]\s*\n\s*pull_request:/);
  assert.match(ci, /node-version: "22"/);
  assert.match(ci, /--experimental-strip-types --experimental-test-coverage/);
  assert.match(ci, /--test-coverage-include='src\/\*\.mjs'/);
  assert.match(ci, /--test-coverage-include='src\/\*\.ts'/);
  assert.match(ci, /--test-reporter=junit --test-reporter-destination=junit\.xml/);
  assert.match(ci, /--test-reporter=lcov --test-reporter-destination=lcov\.info/);
  assert.match(ci, /--coverage lcov\.info --ci failure --json benchmark-smoke\.json/);
  assert.match(ci, /node test\/verify-lcov-inventory\.mjs lcov\.info/);
  assert.ok(ci.indexOf('node test/verify-lcov-inventory.mjs lcov.info') < ci.indexOf('--coverage lcov.info --ci failure'),
    'check the tracked source inventory before parsing or uploading coverage');
  assert.match(ci, /TEST_OUTCOME: \$\{\{ steps\.tests\.outcome \}\}/);
  const upload = ci.slice(ci.indexOf("      - name: Upload Benchmark inputs"));
  assert.match(upload, /if: always\(\)/);
  assert.match(upload, /uses: actions\/upload-artifact@v4/);
  assert.match(upload, /name: benchmark-ci/);
  assert.match(upload, /path: \|\s*\n\s*junit\.xml\s*\n\s*lcov\.info/);
  assert.match(upload, /if-no-files-found: ignore/);
});

test("Node 22 native dual reporters emit LCOV that Benchmark can parse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "benchmark-ci-lcov-"));
  try {
    const junit = join(dir, "junit.xml");
    const lcov = join(dir, "lcov.info");
    // Exercise the real test runner, not a handcrafted LCOV fixture. This
    // catches incompatible native-reporter flags and output-format changes.
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types", "--experimental-test-coverage",
      "--test-coverage-include=src/*.mjs",
      "--test-coverage-include=src/*.ts",
      "--test", "--test-reporter=junit",
      "--test-reporter-destination=" + junit,
      "--test-reporter=lcov",
      "--test-reporter-destination=" + lcov,
      "test/core.test.mjs"
    ], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      // The parent CI test runner sets NODE_TEST_CONTEXT=child-v8. If it
      // leaks into this subprocess, Node silently skips the nested tests.
      // Keep the smoke invocation an independent top-level test run.
      env: Object.fromEntries(Object.entries(process.env).filter(
        ([key]) => key !== "NODE_TEST_CONTEXT" && key !== "NODE_V8_COVERAGE"
      ))
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);

    const [junitText, lcovText] = await Promise.all([
      readFile(junit, "utf8"), readFile(lcov, "utf8")
    ]);
    const tests = parseJunit(junitText);
    const coverage = parseLcov(lcovText);
    assert.ok(tests.total > 0, "JUnit must contain executed tests");
    assert.ok(coverage.lines.found > 0, "LCOV must contain measured lines");
    assert.ok(coverage.functions.found > 0, "LCOV must contain functions");
    assert.match(lcovText, /SF:src\/core\.ts/);
    assert.doesNotMatch(lcovText, /^SF:test\//m,
      "Test files must not be counted in source coverage");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
