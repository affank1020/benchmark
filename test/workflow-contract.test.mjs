import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (name) => readFile(new URL(name, import.meta.url), "utf8");

test("dogfood publisher stays aligned with the documented example", async () => {
  const example = await source("../examples/report-pr.yml");
  const installed = await source("../.github/workflows/benchmark-report.yml");
  const normalized = example.replace(
    "# Copy this file to .github/workflows/benchmark-report.yml in a consuming repo.\n" +
    "# Edit 'workflows: [CI]' to the exact name of the existing PR CI workflow.",
    "# Dogfood Benchmark's trusted publisher on Benchmark pull requests.\n" +
    "# Keep this workflow in sync with examples/report-pr.yml until integration is packaged."
  );
  assert.equal(installed, normalized,
    "Changes to the reusable example should also update Benchmark's dogfood workflow");
});

test("dogfood job only publishes trusted completed PR CI results", async () => {
  const workflow = await source("../.github/workflows/benchmark-report.yml");
  assert.match(workflow, /workflow_run:\s*\n\s*workflows: \[CI\]\s*\n\s*types: \[completed\]/);
  assert.match(workflow, /if: github\.event\.workflow_run\.event == 'pull_request'/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /concurrency:[\s\S]*?cancel-in-progress: false/);
  assert.match(workflow, /repository: affank1020\/benchmark\s*\n\s*ref: [a-f0-9]{40}\b/);
  assert.doesNotMatch(workflow, /\bref:\s*(main|master|HEAD|v\d+|\$\{\{)/);
  const publicExample = await source("../examples/report-pr.yml");
  assert.match(publicExample, /repository: affank1020\/benchmark\s*\n\s*ref: [a-f0-9]{40}\b/);
  assert.doesNotMatch(publicExample, /\bref:\s*(main|master|HEAD|v\d+|\$\{\{)/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /policy\.resolveRunPr\(/);
  assert.ok(
    workflow.indexOf("- name: Checkout trusted Benchmark implementation") <
    workflow.indexOf("- name: Resolve current PR safely"),
    "trusted code must be loaded before resolving fork PRs"
  );
  assert.match(workflow, /group: benchmark-report-\$\{\{ github\.repository_id \}\}-\$\{\{ github\.event\.workflow_run\.head_repository\.id \}\}/);
  assert.doesNotMatch(workflow, /workflow_run\.pull_requests\[0\]\.number/);
  assert.match(workflow, /policy\.matchesRunToPr\(run, current\)/);
  assert.match(workflow, /policy\.isLatestCompletedRun\(run, runs\)/);
  assert.match(workflow, /policy\.findOwnedReportComment\(comments, marker\)/);
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.pull_request\.head/);
});


test("lifecycle workflow is trusted, API-only, and concurrency-compatible", async () => {
  const [installed, example, publisher] = await Promise.all([
    source("../.github/workflows/benchmark-lifecycle.yml"),
    source("../examples/lifecycle-pr.yml"),
    source("../.github/workflows/benchmark-report.yml")
  ]);
  assert.equal(installed.replace(
    "# Trusted API-only pull_request_target status workflow. Never checkout PR code.",
    "# Copy to .github/workflows/benchmark-lifecycle.yml in the consumer.\n# This pull_request_target workflow only uses the trusted GitHub API; never checkout or execute PR code."
  ), example);
  assert.match(installed, /pull_request_target:[\s\S]*types: \[opened, reopened, synchronize, ready_for_review\]/);
  assert.match(installed, /issues: write/);
  assert.doesNotMatch(installed, /actions\/checkout|\brun:|\buses: (?!actions\/github-script@v7)/);
  assert.match(installed, /current\.head\?\.repo\?\.id !== incoming\.head\.repo\.id/);
  assert.match(installed, /current\.head\?\.sha !== incoming\.head\.sha/);
  assert.match(installed, /current\.base\?\.repo\?\.id !== context\.payload\.repository\?\.id/);
  assert.match(installed, /group: benchmark-report-/);
  assert.match(publisher, /group: benchmark-report-/);
  assert.match(publisher, /Publish processing status on the same PR comment/);
  assert.match(publisher, /Replace stuck processing status on failure/);
  assert.match(publisher, /benchmark-state:ready/);
});
