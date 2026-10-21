import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLcov, parseJunit, parseJest, renderMarkdown, normalizeCi } from "../src/core.ts";

test("LCOV aggregates records and reports absent branch metrics as unavailable", () => {
  const coverage = parseLcov("SF:a.ts\nLF:4\nLH:3\nFNF:2\nFNH:1\nend_of_record\nSF:b.ts\nLF:6\nLH:3\nend_of_record\n");
  assert.equal(coverage.lines.percent, 60);
  assert.equal(coverage.functions.percent, 50);
  assert.equal(coverage.branches.percent, null);
});
test("LCOV rejects missing records and inconsistent totals", () => {
  assert.throws(() => parseLcov("LF:10\nLH:10"));
  assert.throws(() => parseLcov("SF:x\nLF:1\nLH:2\nend_of_record"));
});
test("JUnit sums suites, errors count as failures", () => {
  const result = parseJunit('<testsuites><testsuite name="a" tests="4" failures="1" errors="1" skipped="1"></testsuite><testsuite tests="2" failures="0"/></testsuites>');
  assert.deepEqual(result, { total: 6, passed: 3, failed: 2, skipped: 1 });
});
test("Jest JSON reports counts without requiring test suite details", () => {
  assert.deepEqual(parseJest(JSON.stringify({ numTotalTests: 8, numFailedTests: 1, numPendingTests: 2 })), { total: 8, passed: 5, failed: 1, skipped: 2 });
});
test("Failures are always visible even when no artifacts were produced", () => {
  const markdown = renderMarkdown({ ci: "failure", diagnostics: ["Coverage artifact missing or invalid"] });
  assert.match(markdown, /❌ Failed/);
  assert.match(markdown, /Not reported/);
  assert.match(markdown, /Coverage artifact missing or invalid/);
  assert.match(markdown, /benchmark-pr-quality-report/);
});
test("Unknown conclusion cannot inject markdown", () => {
  assert.equal(normalizeCi("success | injected"), "unknown");
});
