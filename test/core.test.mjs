import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLcov, parseJunit, parseJest, renderMarkdown, normalizeCi, compareCoverage } from "../src/core.ts";

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
test("coverage comparison reports signed percentage-point deltas", () => {
  const current = parseLcov("LF:10\nLH:6\nFNF:4\nFNH:2\nBRF:4\nBRH:2\nend_of_record");
  const baseline = parseLcov("LF:10\nLH:5\nFNF:4\nFNH:2\nBRF:4\nBRH:3\nend_of_record");
  assert.deepEqual(compareCoverage(current, baseline), {
    lines: 10, functions: 0, branches: -25
  });
  const report = renderMarkdown({
    ci: "success", coverage: current, baselineCoverage: baseline
  });
  assert.match(report, /\| Metric \| Result \| Baseline \| Change \|/);
  assert.match(report, /\| Line coverage \| 60\.00% \| 50\.00% \| \+10\.00 pp \|/);
  assert.match(report, /\| Function coverage \| 50\.00% \| 50\.00% \| \+0\.00 pp \|/);
  assert.match(report, /\| Branch coverage \| 50\.00% \| 75\.00% \| -25\.00 pp \|/);
  assert.match(report, /file scopes must be comparable/);
});
test("unavailable baseline/current metrics never become zero or a fabricated delta", () => {
  const current = parseLcov("LF:10\nLH:0\nFNF:0\nFNH:0\nBRF:4\nBRH:0\nend_of_record");
  const baseline = parseLcov("LF:10\nLH:5\nFNF:0\nFNH:0\nBRF:0\nBRH:0\nend_of_record");
  assert.deepEqual(compareCoverage(current, baseline), {
    lines: -50, functions: null, branches: null
  });
  assert.deepEqual(compareCoverage(undefined, baseline), {
    lines: null, functions: null, branches: null
  });
  assert.equal(compareCoverage(current, undefined), undefined);
  const report = renderMarkdown({ ci: "failure", baselineCoverage: baseline });
  assert.match(report, /\| Line coverage \| Not reported \| 50\.00% \| Not reported \|/);
  assert.match(report, /\| Branch coverage \| Not reported \| Not reported \| Not reported \|/);
});
test("report without baseline retains the original two-column format", () => {
  const coverage = parseLcov("LF:1\nLH:1\nend_of_record");
  const report = renderMarkdown({ ci: "success", coverage });
  assert.match(report, /\| Metric \| Result \|\n\| --- \| --- \|/);
  assert.doesNotMatch(report, /\| Baseline \||percentage points|\bpp\b/);
});
test("JUnit sums suites, errors count as failures", () => {
  const result = parseJunit('<testsuites><testsuite name="a" tests="4" failures="1" errors="1" skipped="1"></testsuite><testsuite tests="2" failures="0" errors="0" skipped="0"/></testsuites>');
  assert.deepEqual(result, { total: 6, passed: 3, failed: 2, skipped: 1 });
});
test("JUnit avoids double counting hierarchical suite summaries", () => {
  const xml = `<?xml version="1.0"?>
    <testsuites tests="2" failures="1">
      <testsuite name="parent" tests="2" failures="1">
        <testsuite name="child" tests="2" failures="1">
          <testcase classname="example" name="works"/>
          <testcase classname="example" name="fails"><failure/></testcase>
        </testsuite>
      </testsuite>
    </testsuites>`;
  assert.deepEqual(parseJunit(xml), { total: 2, passed: 1, failed: 1, skipped: 0 });
});
test("JUnit sums sibling top-level suites without summing nested children", () => {
  const xml = '<testsuites><testsuite tests="2" failures="1" errors="0" skipped="0"><testsuite tests="2" failures="1"/></testsuite><testsuite tests="3" failures="0" errors="0" skipped="1"/></testsuites>';
  assert.deepEqual(parseJunit(xml), { total: 5, passed: 3, failed: 1, skipped: 1 });
});
test("JUnit handles greater-than signs in quoted attributes and ignores comments and CDATA", () => {
  const xml = `<testsuites>
    <!-- <testsuite tests="999"/> -->
    <testsuite name="value > threshold" tests="2" failures="1">
      <testcase name='when x > y'><![CDATA[<testsuite tests="999"/>]]></testcase>
      <testcase name="fails"><failure message="actual failure"/></testcase>
    </testsuite>
  </testsuites>`;
  assert.deepEqual(parseJunit(xml), { total: 2, passed: 1, failed: 1, skipped: 0 });
});
test("JUnit rejects malformed/nested unsupported XML instead of fabricating totals", () => {
  assert.throws(() => parseJunit('<testsuites><testsuite tests="2"></testsuites>'), /nesting/);
  assert.throws(() => parseJunit('<testsuites><testsuite tests="2" failures="0" errors="0" skipped="0"/></testsuites><testsuite tests="3"/>'), /root/);
  assert.throws(() => parseJunit('<!DOCTYPE testsuites><testsuites><testsuite tests="2"/></testsuites>'), /Unsupported XML/);
  assert.throws(() => parseJunit('<testsuites><testsuite name="unbounded"><testsuite tests="2"/></testsuite></testsuites>'), /missing tests/);
});
test("Node.js 22 JUnit reporter root-level testcase format reports all outcomes", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <testsuites>
      <testcase name="passes" time="0.001" classname="test"/>
      <testcase name="todo" classname="test"><skipped type="todo" message="pending"/></testcase>
      <testcase name="fails" classname="test" failure="boom">
        <failure type="testCodeFailure" message="boom">failure details</failure>
      </testcase>
      <!-- tests 3 -->
      <!-- pass 1 -->
      <!-- fail 1 -->
      <!-- todo 1 -->
    </testsuites>`;
  assert.deepEqual(parseJunit(xml), { total: 3, passed: 1, failed: 1, skipped: 1 });
});
test("JUnit can report flat root testcases and independent suites without double counting", () => {
  const xml = `<testsuites tests="3" failures="1" errors="0" skipped="0">
    <testcase name="direct"><failure/></testcase>
    <testsuite tests="2" failures="0" errors="0" skipped="0"/>
  </testsuites>`;
  assert.deepEqual(parseJunit(xml), { total: 3, passed: 2, failed: 1, skipped: 0 });
});
test("JUnit rejects root aggregate contradictions and invalid testcase nesting", () => {
  assert.throws(() => parseJunit(
    '<testsuites tests="2"><testcase name="one"/></testsuites>'
  ), /root test counts disagree/);
  assert.throws(() => parseJunit(
    '<testsuites><wrapper><testcase/></wrapper></testsuites>'
  ), /Invalid JUnit testcase nesting/);
});
test("JUnit derives missing suite failures from testcase outcomes", () => {
  const xml = '<testsuite tests="1"><testcase name="fails"><failure message="boom"/></testcase></testsuite>';
  assert.deepEqual(parseJunit(xml), { total: 1, passed: 0, failed: 1, skipped: 0 });
});
test("JUnit derives errors and skipped cases without optional suite counters", () => {
  const xml = '<testsuites><testsuite tests="3" failures="0">' +
    '<testcase name="passes"/><testcase name="errors"><error/></testcase>' +
    '<testcase name="skips"><skipped/></testcase></testsuite></testsuites>';
  assert.deepEqual(parseJunit(xml), { total: 3, passed: 1, failed: 1, skipped: 1 });
});
test("JUnit validates declared failure, error, and skipped counters against complete cases", () => {
  assert.throws(() => parseJunit(
    '<testsuite tests="1" failures="0"><testcase><failure/></testcase></testsuite>'
  ), /disagree/);
  assert.throws(() => parseJunit(
    '<testsuite tests="1" errors="0"><testcase><error/></testcase></testsuite>'
  ), /disagree/);
  assert.throws(() => parseJunit(
    '<testsuite tests="1" skipped="0"><testcase><skipped/></testcase></testsuite>'
  ), /disagree/);
});
test("JUnit rejects incomplete outcome evidence instead of reporting a false pass", () => {
  assert.throws(() => parseJunit('<testsuite tests="1"/>'), /Incomplete JUnit outcome/);
  assert.throws(() => parseJunit(
    '<testsuite tests="2"><testcase><failure/></testcase></testsuite>'
  ), /Incomplete JUnit outcome/);
  assert.throws(() => parseJunit(
    '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase><failure/></testcase></testsuite>'
  ), /disagree/);
});
test("JUnit tolerates omitted suite counters when the suite declares zero tests", () => {
  assert.deepEqual(parseJunit('<testsuite tests="0"/>'), {
    total: 0, passed: 0, failed: 0, skipped: 0
  });
});
test("Jest JSON reports counts without requiring test suite details", () => {
  assert.deepEqual(parseJest(JSON.stringify({ numTotalTests: 8, numFailedTests: 1, numPendingTests: 2 })), { total: 8, passed: 5, failed: 1, skipped: 2 });
});
test("Jest TODOs are non-passing and counted as skipped", () => {
  assert.deepEqual(parseJest(JSON.stringify({
    numTotalTests: 2, numPassedTests: 1, numFailedTests: 0,
    numPendingTests: 0, numTodoTests: 1
  })), { total: 2, passed: 1, failed: 0, skipped: 1 });
});
test("Jest rejects contradictory explicit passed/TODO totals", () => {
  assert.throws(() => parseJest(JSON.stringify({
    numTotalTests: 2, numPassedTests: 2, numTodoTests: 1
  })), /Jest counts inconsistent/);
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
