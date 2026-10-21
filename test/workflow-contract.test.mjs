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
  assert.match(workflow, /concurrency:[\s\S]*?cancel-in-progress: false/);
  assert.match(workflow, /repository: affank1020\/benchmark\s*\n\s*ref: main/);
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
