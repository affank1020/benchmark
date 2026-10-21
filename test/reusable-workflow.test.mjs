import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = path => readFile(new URL(path, import.meta.url), "utf8");

test("reusable workflow is callable, artifact-parametrized and uses pinned trusted code", async () => {
  const reusable = await load("../.github/workflows/reusable-report.yml");
  assert.match(reusable, /workflow_call:\s*\n\s*inputs:/);
  assert.match(reusable, /artifact_name:[\s\S]*?type: string\s*\n\s*default: benchmark-ci/);
  assert.match(reusable, /BENCHMARK_ARTIFACT_NAME: \$\{\{ inputs\.artifact_name \}\}/);
  assert.match(reusable, /name: \$\{\{ inputs\.artifact_name \}\}/);
  assert.match(reusable, /repository: affank1020\/benchmark\s*\n\s*ref: [a-f0-9]{40}/);
  assert.match(reusable, /issues: write\s*\n\s*pull-requests: write/);
  assert.doesNotMatch(reusable, /ref: main/);
  assert.doesNotMatch(reusable, /pull_request_target/);
});

test("reusable workflow preserves the trusted publisher's complete control flow", async () => {
  const reusable = await load("../.github/workflows/reusable-report.yml");
  const installed = await load("../.github/workflows/benchmark-report.yml");
  const coreSection = value => value.slice(value.indexOf("permissions:\n"));
  let expected = coreSection(installed)
    .replace(
      "ref: main # Pin a released commit SHA once available.",
      "ref: c4aa9c6a76d71e57809954cbc17627dcb250ab56 # Trusted Benchmark release baseline (PR #2 merge)"
    )
    .replace(
      "        uses: actions/github-script@v7\n        with:\n          script: |\n            const { owner, repo } = context.repo;\n            const run_id = context.payload.workflow_run.id;",
      "        uses: actions/github-script@v7\n        env:\n          BENCHMARK_ARTIFACT_NAME: ${{ inputs.artifact_name }}\n        with:\n          script: |\n            const { owner, repo } = context.repo;\n            const run_id = context.payload.workflow_run.id;"
    )
    .replace(
      "artifacts.find(a => a.name === 'benchmark-ci' && !a.expired)",
      "artifacts.find(a => a.name === process.env.BENCHMARK_ARTIFACT_NAME && !a.expired)"
    )
    .replace("name: benchmark-ci\n          path: artifacts", "name: ${{ inputs.artifact_name }}\n          path: artifacts");
  assert.equal(coreSection(reusable), expected,
    "Reusable and installed publishers should only differ in intentional input/pinning substitutions");
});

test("short consumer example is a trusted workflow_run caller, not PR code execution", async () => {
  const consumer = await load("../examples/use-reusable-report.yml");
  assert.match(consumer, /workflow_run:\s*\n\s*workflows: \[CI\]\s*\n\s*types: \[completed\]/);
  const ref = /uses: affank1020\/benchmark\/\.github\/workflows\/reusable-report\.yml@([^\s]+)/.exec(consumer)?.[1];
  assert.ok(ref, "Reusable workflow reference must be present");
  assert.ok(
    /^[a-f0-9]{40}$/.test(ref) || ref === "REPLACE_WITH_REVIEWED_40_CHAR_RELEASE_SHA",
    "Caller must pin a reviewed immutable SHA or use a conspicuous non-runnable placeholder"
  );
  assert.notEqual(ref, "main");
  assert.match(consumer, /pull-requests: write/);
  assert.match(consumer, /if: github\.event\.workflow_run\.event == 'pull_request'/);
  assert.match(consumer, /issues: write/);
  assert.match(consumer, /actions: read/);
  assert.doesNotMatch(consumer, /pull_request_target|actions\/checkout/);
});
