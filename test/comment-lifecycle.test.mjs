import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matchesRunToPr, resolveRunPr, isLatestCompletedRun, findOwnedReportComment } from "../src/publish-policy.mjs";

const load = path => readFile(new URL(path, import.meta.url), "utf8");
const marker = "<!-- benchmark-pr-quality-report -->";
const sha = "a".repeat(40);
const fork = { number: 41, state: "open", head: { sha, ref: "feature", repo: { id: 501 } }, base: { sha: "base-sha", ref: "main", repo: { id: 500, full_name: "org/consumer" } } };
const run = { id: 12, workflow_id: 23, run_number: 8, run_attempt: 1, event: "pull_request", status: "completed", head_sha: sha, head_branch: "feature", head_repository: { id: 501, owner: { login: 'contributor' } } };

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
   step = "Create or refresh waiting comment for current CI attempt",
   current = fork, comments = [], runState, candidates = [run],
   payloadRun = run, listed = [{ number: 41 }], associated = [], pullRequests
} = {}) {
  const yaml = await load(file);
  let code = extractScript(yaml, step);
  code = code.replace(
    "const { pathToFileURL } = require('url');\n" +
    "const policy = await import(pathToFileURL(\n" +
    "  process.env.GITHUB_WORKSPACE + '/benchmark/src/publish-policy.mjs'\n" +
    ").href);\n", "");
  if (step === "Update one PR comment if still current") {
    code = code.replace("const { readFileSync } = require('fs');\n", "");
    code = code.replace(
      "const body = readFileSync('benchmark-report.md', 'utf8');",
      "const body = process.env.TEST_REPORT;"
    );
  }
  const isLifecycle = file.includes("benchmark-lifecycle.yml");
  const live = runState ?? { ...payloadRun, status: isLifecycle ? "in_progress" : "completed" };
  const writes = [], warnings = [], requests = [];
  const data = {
    repo: { owner: "org", repo: "consumer" },
    payload: { repository: { id: 500 }, workflow_run: payloadRun }
  };
  const github = {
    rest: {
      pulls: {
        get: async ({ pull_number }) => ({
          data: pullRequests?.find(item => item.number === pull_number) ?? current
        }),
        list: async args => {
          requests.push({ api: "pulls.list", args });
          return listed;
        }
      },
      repos: { listPullRequestsAssociatedWithCommit: async () => associated },
      actions: {
        getWorkflowRun: async () => ({ data: live }),
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
    { env: {
      BENCHMARK_PR_NUMBER: "41",
      BENCHMARK_BASE_SHA: "base-sha",
      BENCHMARK_BASE_REF: "main",
      BENCHMARK_BASE_RUN_ID: "999",
      BENCHMARK_BASE_RUN_ATTEMPT: "1",
      TEST_REPORT: marker + "\n## Quality Report"
    } },
    { matchesRunToPr, resolveRunPr, isLatestCompletedRun, findOwnedReportComment }
  );
  return { writes, warnings, requests };
}

test("CI-start workflow resolves a fork and creates its single waiting comment", async () => {
  const { writes, requests } = await runStep();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "create");
  assert.equal(writes[0].issue_number, 41);
  assert.match(writes[0].body, /benchmark-state:waiting/);
  assert.match(writes[0].body, /benchmark-ci-run:12:1/);
  assert.match(writes[0].body, /benchmark-head-sha:/);
  assert.ok(requests.some(x => x.api === "pulls.list" &&
    x.args.head === "contributor:feature"));
});

test("stale or ambiguous fork PRs cannot receive a waiting comment", async () => {
  const other = { ...fork, number: 42 };
  for (const options of [
    { current: { ...fork, state: "closed" } },
    { current: { ...fork, head: { ...fork.head, sha: "b".repeat(40) } } },
    { current: { ...fork, head: { ...fork.head, repo: { id: 900 } } } },
    { current: { ...fork, base: { ...fork.base, repo: { id: 900, full_name: "org/consumer" } } } },
    { payloadRun: { ...run, event: "push" } },
    { listed: [{ number: 41 }, { number: 42 }], pullRequests: [fork, other] }
  ]) {
    assert.equal((await runStep(options)).writes.length, 0, JSON.stringify(options));
  }
});

test("duplicate requested/in_progress events never downgrade this run's status", async () => {
  for (const state of ["waiting", "processing", "ready", "error", "unavailable"]) {
    const old = { id: 77, user: { login: "github-actions[bot]" },
      body: marker + "\n<!-- benchmark-head-sha:" + sha +
        " -->\n<!-- benchmark-ci-run:12:1 -->\n<!-- benchmark-state:" + state + " -->" };
    assert.equal((await runStep({ comments: [old] })).writes.length, 0, state);
  }
});

test("new head and rerun replace the same bot-owned comment", async () => {
  const old = { id: 77, user: { login: "github-actions[bot]" },
    body: marker + "\n<!-- benchmark-head-sha:" + "b".repeat(40) +
      " -->\n<!-- benchmark-ci-run:10:1 -->\n<!-- benchmark-state:ready -->" };
  const first = await runStep({ comments: [old] });
  assert.equal(first.writes.length, 1);
  assert.equal(first.writes[0].kind, "update");
  assert.equal(first.writes[0].comment_id, 77);
  assert.match(first.writes[0].body, /Waiting for CI results/);
  const secondRun = { ...run, run_attempt: 2, status: "in_progress" };
  const updated = await runStep({
    comments: [{ ...old, body: first.writes[0].body }],
    payloadRun: secondRun, runState: secondRun, candidates: [secondRun]
  });
  assert.equal(updated.writes.length, 1);
  assert.equal(updated.writes[0].kind, "update");
  assert.equal(updated.writes[0].comment_id, 77);
  assert.match(updated.writes[0].body, /benchmark-ci-run:12:2/);
});

test("completed, restarted, or newer queued CI runs never publish waiting", async () => {
  for (const options of [
    { runState: { ...run, status: "completed" } },
    { runState: { ...run, run_attempt: 2, status: "in_progress" } },
    { runState: { ...run, head_branch: "changed", status: "in_progress" } },
    { candidates: [{ ...run, run_attempt: 2 }] },
    { candidates: [{ ...run, id: 13, run_number: 9, status: "queued" }, run] },
    { candidates: [] }
  ]) {
    assert.equal((await runStep(options)).writes.length, 0, JSON.stringify(options));
  }
});

test("a foreign bot's marked comment is never updated", async () => {
  const old = { id: 1, user: { login: "foreign[bot]" }, body: marker };
  const result = await runStep({ comments: [old] });
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].kind, "create");
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


test("processing → changed base → successful publication skip → reconciliation removes stuck processing", async () => {
  const file = "../.github/workflows/benchmark-report.yml";
  const processing = await runStep({
    file, step: "Publish processing status on the same PR comment"
  });
  assert.equal(processing.writes.length, 1);
  const prior = { id: 77, user: { login: "github-actions[bot]" },
    body: processing.writes[0].body };
  assert.match(prior.body, /benchmark-state:processing/);
  assert.match(prior.body, /benchmark-ci-run:12:1/);
  const moved = { ...fork, base: { ...fork.base, sha: "changed-base" } };
  const published = await runStep({
    file, step: "Update one PR comment if still current",
    current: moved, comments: [prior]
  });
  assert.deepEqual(published.writes, [], "stale baseline must not publish any coverage");
  assert.ok(published.warnings.some(w => /base commit or branch changed/.test(w)));

  const reconciled = await runStep({
    file, step: "Reconcile skipped or interrupted processing status",
    current: moved, comments: [prior]
  });
  assert.equal(reconciled.writes.length, 1);
  assert.equal(reconciled.writes[0].kind, "update");
  assert.equal(reconciled.writes[0].comment_id, 77);
  assert.match(reconciled.writes[0].body, /benchmark-state:unavailable/);
  assert.match(reconciled.writes[0].body, /PR base changed/);
  assert.doesNotMatch(reconciled.writes[0].body, /benchmark-state:processing/);
});

test("finalizer never overwrites a newer head, run, or final state", async () => {
  const file = "../.github/workflows/benchmark-report.yml";
  const oldBody = marker + "\n<!-- benchmark-head-sha:" + sha +
    " -->\n<!-- benchmark-ci-run:12:1 -->\n<!-- benchmark-state:processing -->";
  const cases = [
    { current: { ...fork, head: { ...fork.head, sha: "b".repeat(40) } } },
    { current: { ...fork, state: "closed" } },
    { comments: [{ id: 77, user: { login: "github-actions[bot]" },
      body: oldBody.replace("12:1", "14:1") }] },
    { comments: [{ id: 77, user: { login: "github-actions[bot]" },
      body: oldBody.replace("processing", "ready") }] },
    { comments: [{ id: 77, user: { login: "another[bot]" }, body: oldBody }] }
  ];
  for (const options of cases) {
    const result = await runStep({
      file, step: "Reconcile skipped or interrupted processing status",
      comments: [{ id: 77, user: { login: "github-actions[bot]" }, body: oldBody }],
      ...options
    });
    assert.equal(result.writes.length, 0, JSON.stringify(options));
  }
});

test("a superseded CI attempt becomes awaiting rather than permanently processing", async () => {
  const old = { id: 77, user: { login: "github-actions[bot]" },
    body: marker + "\n<!-- benchmark-head-sha:" + sha +
      " -->\n<!-- benchmark-ci-run:12:1 -->\n<!-- benchmark-state:processing -->" };
  const newer = { ...run, id: 15, run_number: 9, status: "in_progress" };
  const { writes } = await runStep({
    file: "../.github/workflows/reusable-report.yml",
    step: "Reconcile skipped or interrupted processing status",
    comments: [old], candidates: [run, newer]
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "update");
  assert.equal(writes[0].comment_id, 77);
  assert.match(writes[0].body, /superseded by a newer attempt/);
  assert.match(writes[0].body, /benchmark-state:unavailable/);
});

test("reconciliation is unconditional after publication and identical across publishers", async () => {
  const files = await Promise.all([
    load("../.github/workflows/benchmark-report.yml"),
    load("../examples/report-pr.yml"),
    load("../.github/workflows/reusable-report.yml")
  ]);
  for (const workflow of files) {
    const label = "Reconcile skipped or interrupted processing status";
    const finalizer = workflow.slice(workflow.indexOf("      - name: " + label));
    assert.match(finalizer, /if: \$\{\{ always\(\) && steps\.pr\.outputs\.number != '' \}\}/);
    assert.ok(workflow.indexOf(label) > workflow.indexOf("Replace stuck processing status on failure"));
    assert.match(finalizer, /benchmark-ci-run:/);
    assert.match(finalizer, /benchmark-state:processing/);
    assert.match(finalizer, /benchmark-state:unavailable/);
  }
  const scripts = files.map(text => extractScript(text,
    "Reconcile skipped or interrupted processing status"));
  assert.equal(scripts[0], scripts[1]);
  assert.equal(scripts[0], scripts[2]);
});
