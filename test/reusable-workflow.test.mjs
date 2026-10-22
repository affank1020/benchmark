import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = path => readFile(new URL(path, import.meta.url), "utf8");

test("reusable workflow is callable, artifact-parametrized and uses pinned trusted code", async () => {
  const reusable = await load("../.github/workflows/reusable-report.yml");
  assert.match(reusable, /workflow_call:\s*\n\s*inputs:/);
  assert.match(reusable, /artifact_name:[\s\S]*?type: string\s*\n\s*default: benchmark-ci/);
  assert.match(reusable, /BENCHMARK_ARTIFACT_NAME: \$\{\{ inputs\.coverage_artifact_name \|\| inputs\.artifact_name \}\}/);
  assert.match(reusable, /BENCHMARK_TESTS_ARTIFACT_NAME: \$\{\{ inputs\.tests_artifact_name \|\| inputs\.artifact_name \}\}/);
  assert.match(reusable, /BENCHMARK_COVERAGE_ARTIFACT_NAME: \$\{\{ inputs\.coverage_artifact_name \|\| inputs\.artifact_name \}\}/);
  assert.match(reusable, /tests_artifact_name:[\s\S]*?default: ''/);
  assert.match(reusable, /coverage_artifact_name:[\s\S]*?default: ''/);
  assert.match(reusable, /repository: affank1020\/benchmark\s*\n\s*ref: [a-f0-9]{40}/);
  assert.match(reusable, /issues: write\s*\n\s*pull-requests: write/);
  assert.doesNotMatch(reusable, /\bref:\s*(main|master|HEAD|v\d+|\$\{\{)/);
  const fullExample = await load("../examples/report-pr.yml");
  const installed = await load("../.github/workflows/benchmark-report.yml");
  const pinned = /repository: affank1020\/benchmark\s*\n\s*ref: ([a-f0-9]{40})\b/;
  for (const workflow of [fullExample, installed, reusable]) {
    assert.match(workflow, pinned);
  }
  assert.equal(fullExample.match(pinned)[1], reusable.match(pinned)[1]);
  assert.equal(installed.match(pinned)[1], reusable.match(pinned)[1]);
  assert.doesNotMatch(reusable, /pull_request_target/);
});

test("reusable workflow preserves the trusted publisher's complete control flow", async () => {
  const reusable = await load("../.github/workflows/reusable-report.yml");
  const installed = await load("../.github/workflows/benchmark-report.yml");
  const coreSection = value => value.slice(value.indexOf("permissions:\n"));
  const expected = coreSection(installed)
    .replace(
      "          BENCHMARK_TESTS_ARTIFACT_NAME: benchmark-ci",
      "          BENCHMARK_TESTS_ARTIFACT_NAME: ${{ inputs.tests_artifact_name || inputs.artifact_name }}"
    )
    .replace(
      "          BENCHMARK_COVERAGE_ARTIFACT_NAME: benchmark-ci",
      "          BENCHMARK_COVERAGE_ARTIFACT_NAME: ${{ inputs.coverage_artifact_name || inputs.artifact_name }}"
    )
    .replace(
      "          BENCHMARK_ARTIFACT_NAME: benchmark-ci",
      "          BENCHMARK_ARTIFACT_NAME: ${{ inputs.coverage_artifact_name || inputs.artifact_name }}"
    );
  assert.equal(coreSection(reusable), expected,
    "Reusable and installed publishers should only differ in intentional input/pinning substitutions");
});

test("short consumer example is a trusted workflow_run caller, not PR code execution", async () => {
  const consumer = await load("../examples/use-reusable-report.yml");
  assert.match(consumer, /workflow_run:\s*\n\s*workflows: \[CI\]\s*\n\s*types: \[completed\]/);
  const ref = /uses: affank1020\/benchmark\/\.github\/workflows\/reusable-report\.yml@([^\s]+)/.exec(consumer)?.[1];
  assert.ok(ref, "Reusable workflow reference must be present");
  assert.match(ref, /^[a-f0-9]{40}$/, "Consumer caller must pin an immutable reviewed commit");
  assert.equal(ref, "bb128d710834af8f763eb116bfd768af9d326d9b", "Consumer example should reference the reviewed PR #6 release");
  assert.notEqual(ref, "main");
  assert.match(consumer, /pull-requests: write/);
  assert.match(consumer, /if: github\.event\.workflow_run\.event == 'pull_request'/);
  assert.match(consumer, /issues: write/);
  assert.match(consumer, /actions: read/);
  assert.doesNotMatch(consumer, /pull_request_target|actions\/checkout/);
});
