import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matchesRunToPr, isLatestCompletedRun, findOwnedReportComment } from "../src/publish-policy.mjs";

const load = path => readFile(new URL(path, import.meta.url), "utf8");
const marker = "<!-- benchmark-pr-quality-report -->";
const sha = "a".repeat(40);
const fork = { number: 41, state: "open", head: { sha, ref: "feature", repo: { id: 501 } }, base: { repo: { id: 500, full_name: "org/consumer" } } };
const run = { id: 12, workflow_id: 23, run_number: 8, run_attempt: 1, event: "pull_request", status: "completed", head_sha: sha, head_branch: "feature", head_repository: { id: 501 } };

function extractScript(workflow, stepName) {
  const name = "      - name: " + stepName + "\n";
  const start = workflow.indexOf(name);
  assert.ok(start >= 0, "No step: " + stepName);
  const end = workflow.indexOf("\n      - name:", start + name.length);
  const part = workflow.slice(start, end >= 0 ? end : undefined);
  const marker = "          script: |\n";
  const offset = part.indexOf(marker);
  assert.ok(offset >= 0);
  return part.slice(offset + marker.length).split("\n")
    .map(x => x.startsWith("            ") ? x.slice(12) : x).join("\n");
}

async function runStep({ file = "../.github/workflows/benchmark-lifecycle.yml",
   step = "Create or refresh waiting comment for the current PR head",
   incoming = fork, current = fork, eventNumber = 41, comments = [],
   runState = run, candidates = [run] } = {}) {
  const yaml = await load(file);
  let code = extractScript(yaml, step);
  code = code.replace(
    "const { pathToFileURL } = require('url');\n" +
    "const policy = await import(pathToFileURL(\n" +
    "  process.env.GITHUB_WORKSPACE + '/benchmark/src/publish-policy.mjs'\n" +
    ").href);\n", "");
  const writes = [], warnings = [];
  const data = {
    repo: { owner: "org", repo: "consumer" },
    payload: { number: eventNumber, repository: { id: 500 }, pull_request: incoming, workflow_run: run }
  };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: current }) },
      actions: {
        getWorkflowRun: async () => ({ data: runState }),
        listWorkflowRuns: async () => candidates
      },
      issues: {
        listComments: async () => comments,
        createComment: async args => writes.push({ kind: "create", ...args }),
        updateComment: async args => writes.push({ kind: "update", ...args })
      }
    },
    paginate: (api, args) => api(args)
  };
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  await new AsyncFunction("github", "context", "core", "process", "policy", code)(
    github, data, { warning: x => warnings.push(x), notice: x => warnings.push(x) },
    { env: { BENCHMARK_PR_NUMBER: "41" } },
    { matchesRunToPr, isLatestCompletedRun, findOwnedReportComment }
  );
  return { writes, warnings };
}

test("fork PR creates a waiting comment via default-branch API only", async () => {
  const { writes } = await runStep();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "create");
  assert.equal(writes[0].issue_number, 41);
  assert.match(writes[0].body, /benchmark-state:waiting/);
  assert.ok(writes[0].body.includes("benchmark-head-sha:" + sha));
});

test("stale PR lifecycle events cannot reset newer commits or closed PRs", async () => {
  for (const options of [
    { incoming: { ...fork, head: { ...fork.head, sha: "b".repeat(40) } } },
    { current: { ...fork, state: "closed" } },
    { current: { ...fork, head: { ...fork.head, repo: { id: 999 } } } },
    { current: { ...fork, base: { repo: { id: 999, full_name: "org/consumer" } } } },
    { eventNumber: 99 }
  ]) {
    assert.equal((await runStep(options)).writes.length, 0, JSON.stringify(options));
  }
});

test("same-head late webhook never downgrades processing, error or final report", async () => {
  for (const state of ["waiting", "processing", "ready", "error"]) {
    const old = { id: 77, user: { login: "github-actions[bot]" },
      body: marker + "\n<!-- benchmark-head-sha:" + sha + " -->\n<!-- benchmark-state:" + state + " -->" };
    assert.equal((await runStep({ comments: [old] })).writes.length, 0, state);
  }
});

test("new PR revision resets the same comment without ever creating a duplicate", async () => {
  const old = { id: 77, user: { login: "github-actions[bot]" },
    body: marker + "\n<!-- benchmark-head-sha:" + "b".repeat(40) + " -->\n<!-- benchmark-state:ready -->" };
  const { writes } = await runStep({ comments: [old] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "update");
  assert.equal(writes[0].comment_id, 77);
  assert.match(writes[0].body, /Waiting for CI/);
});

test("completed fresh CI sets processing on the existing bot comment", async () => {
  const old = { id: 77, user: { login: "github-actions[bot]" },
    body: marker + "\n<!-- benchmark-head-sha:" + sha + " -->\n<!-- benchmark-state:waiting -->" };
  const { writes } = await runStep({ file: "../.github/workflows/benchmark-report.yml",
    step: "Publish processing status on the same PR comment", comments: [old] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "update");
  assert.equal(writes[0].comment_id, 77);
  assert.match(writes[0].body, /benchmark-state:processing/);
  assert.match(writes[0].body, /Processing CI results/);
});

test("publisher can create processing fallback when no lifecycle comment exists", async () => {
  const { writes } = await runStep({ file: "../.github/workflows/reusable-report.yml",
    step: "Publish processing status on the same PR comment" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "create");
  assert.match(writes[0].body, /benchmark-state:processing/);
});

test("latest CI run and rerun checks stop stale processing or failure writes", async () => {
  const step = "Publish processing status on the same PR comment";
  const file = "../.github/workflows/benchmark-report.yml";
  for (const options of [
    { current: { ...fork, head: { ...fork.head, sha: "b".repeat(40) } } },
    { runState: { ...run, run_attempt: 2 } },
    { runState: { ...run, status: "in_progress" } },
    { candidates: [{ ...run, id: 13, run_number: 9 }, run] },
    { candidates: [{ ...run, run_attempt: 2 }] },
    { candidates: [] }
  ]) {
    assert.equal((await runStep({ file, step, ...options })).writes.length, 0, JSON.stringify(options));
  }
  const failure = await runStep({ file, step: "Replace stuck processing status on failure" });
  assert.equal(failure.writes.length, 1);
  assert.match(failure.writes[0].body, /benchmark-state:error/);
});

test("every publisher uses exactly the same trusted transition code", async () => {
  const variants = await Promise.all([
    load("../.github/workflows/benchmark-report.yml"),
    load("../examples/report-pr.yml"),
    load("../.github/workflows/reusable-report.yml")
  ]);
  for (const step of [
    "Publish processing status on the same PR comment",
    "Replace stuck processing status on failure"
  ]) {
    const scripts = variants.map(v => extractScript(v, step));
    assert.equal(scripts[0], scripts[1]);
    assert.equal(scripts[0], scripts[2]);
  }
});
