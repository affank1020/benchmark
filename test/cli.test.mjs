import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("CLI consumes flat Node.js 22 JUnit-format artifact end to end", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/node22-junit.xml", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "benchmark-junit-cli-"));
  try {
    const jsonPath = join(directory, "benchmark.json");
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types", cli, "--tests", fixture, "--ci", "failure",
      "--json", jsonPath
    ], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.deepEqual(report.tests, { total: 3, passed: 1, failed: 1, skipped: 1 });
    assert.equal(report.ci, "failure");
    assert.match(result.stdout, /1 passed · 1 failed · 1 skipped \/ 3 total/);
    assert.doesNotMatch(result.stdout, /Test artifact missing or invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI reports baseline LCOV deltas in Markdown and machine-readable JSON", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "benchmark-coverage-"));
  try {
    const current = join(directory, "current.info");
    const baseline = join(directory, "baseline.info");
    const json = join(directory, "report.json");
    writeFileSync(current, "LF:10\nLH:7\nFNF:0\nFNH:0\nend_of_record");
    writeFileSync(baseline, "LF:10\nLH:5\nFNF:0\nFNH:0\nend_of_record");
    const run = spawnSync(process.execPath, [
      "--experimental-strip-types", cli, "--coverage", current,
      "--baseline-coverage", baseline, "--ci", "success", "--json", json
    ], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    const data = JSON.parse(readFileSync(json, "utf8"));
    assert.deepEqual(data.coverageChange, {
      lines: 20, functions: null, branches: null
    });
    assert.equal(data.baselineCoverage.lines.percent, 50);
    assert.match(run.stdout, /\| Line coverage \| 70\.00% \| 50\.00% \| \+20\.00 pp \|/);
    assert.doesNotMatch(run.stdout, /Baseline coverage artifact missing or invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid baseline stays unavailable and never fabricates a change", () => {
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "benchmark-no-baseline-"));
  try {
    const current = join(directory, "coverage.info");
    const missing = join(directory, "missing.info");
    const json = join(directory, "report.json");
    writeFileSync(current, "LF:1\nLH:1\nend_of_record");
    const run = spawnSync(process.execPath, [
      "--experimental-strip-types", cli, "--coverage", current,
      "--baseline-coverage", missing, "--json", json
    ], { encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    const data = JSON.parse(readFileSync(json, "utf8"));
    assert.equal(data.coverageChange, undefined);
    assert.equal(data.baselineCoverage, undefined);
    assert.deepEqual(data.diagnostics, ["Baseline coverage artifact missing or invalid"]);
    assert.match(run.stdout, /Baseline coverage artifact missing or invalid/);
    assert.doesNotMatch(run.stdout, /\| Baseline \| Change \|/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed existing baseline is unavailable, not a fabricated coverage gain", () => {
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "benchmark-bad-baseline-"));
  try {
    const current = join(directory, "current.info");
    const baseline = join(directory, "baseline.info");
    const json = join(directory, "report.json");
    writeFileSync(current, "LF:10\nLH:7\nend_of_record");
    writeFileSync(baseline, "LF:10\nLH:invalid\nend_of_record");
    const run = spawnSync(process.execPath, [
      "--experimental-strip-types", cli, "--coverage", current,
      "--baseline-coverage", baseline, "--json", json
    ], { encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    const data = JSON.parse(readFileSync(json, "utf8"));
    assert.equal(data.coverage.lines.percent, 70);
    assert.equal(data.baselineCoverage, undefined);
    assert.equal(data.coverageChange, undefined);
    assert.deepEqual(data.diagnostics, ["Baseline coverage artifact missing or invalid"]);
    assert.match(run.stdout, /Baseline coverage artifact missing or invalid/);
    assert.doesNotMatch(run.stdout, /\+70\.00 pp|\| Baseline \| Change \|/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed existing current coverage cannot produce a misleading baseline change", () => {
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "benchmark-bad-current-"));
  try {
    const current = join(directory, "current.info");
    const baseline = join(directory, "baseline.info");
    const json = join(directory, "report.json");
    writeFileSync(current, "LF:10\nLH:invalid\nend_of_record");
    writeFileSync(baseline, "LF:10\nLH:5\nend_of_record");
    const run = spawnSync(process.execPath, [
      "--experimental-strip-types", cli, "--coverage", current,
      "--baseline-coverage", baseline, "--json", json
    ], { encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    const data = JSON.parse(readFileSync(json, "utf8"));
    assert.equal(data.coverage, undefined);
    assert.deepEqual(data.coverageChange, {
      lines: null, functions: null, branches: null
    });
    assert.deepEqual(data.diagnostics, ["Coverage artifact missing or invalid"]);
    assert.match(run.stdout, /\| Line coverage \| Not reported \| 50\.00% \| Not reported \|/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
