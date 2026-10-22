import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matchesRunToPr, isLatestCompletedRun, findOwnedReportComment } from "../src/publish-policy.mjs";

const load = path => readFile(new URL(path, import.meta.url), "utf8");

function extractScript(workflow, stepName) {
  const marker = "      - name: " + stepName + "\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1);
  const finish = workflow.indexOf("\n      - name:", start + marker.length);
  const step = workflow.slice(start, finish < 0 ? undefined : finish);
  const scriptMarker = "          script: |\n";
  const scriptStart = step.indexOf(scriptMarker);
  assert.notEqual(scriptStart, -1);
  return step.slice(scriptStart + scriptMarker.length).split("\n")
    .map(line => line.startsWith("            ") ? line.slice(12) : line)
    .join("\n");
}

const run = {
  id: 10, run_number: 10, run_attempt: 1, workflow_id: 300,
  event: "pull_request", status: "completed", conclusion: "success",
  head_sha: "pr-sha", head_branch: "feature",
  head_repository: { id: 110 }
};
const pr = {
  number: 8, state: "open",
  head: { sha: "pr-sha", ref: "feature", repo: { id: 110 } },
  base: { sha: "base-sha", ref: "main", repo: { id: 220 } }
};
const chosen = {
  id: 999, run_number: 16, run_attempt: 1, workflow_id: 300,
  event: "push", status: "completed", conclusion: "success",
  head_sha: "base-sha", head_branch: "main", repository: { id: 220 }
};

async function attemptPublish({
  currentPr = pr,
  selectedRun = chosen,
  baseCandidates = [chosen],
  prCandidates = [run],
  selected = true
} = {}) {
  const workflow = await load("../.github/workflows/benchmark-report.yml");
  let script = extractScript(workflow, "Update one PR comment if still current");
  script = script.replace("const { readFileSync } = require('fs');\n", "");
  script = script.replace(
    "const { pathToFileURL } = require('url');\n" +
    "const policy = await import(pathToFileURL(\n" +
    "  process.env.GITHUB_WORKSPACE + '/benchmark/src/publish-policy.mjs'\n" +
    ").href);\n", ""
  );
  script = script.replace(
    "const body = readFileSync('benchmark-report.md', 'utf8');",
    "const body = process.env.TEST_REPORT;"
  );
  assert.doesNotMatch(script, /readFileSync|require\(|await import\(/);
  const writes = [], requests = [], warnings = [];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: currentPr }) },
      actions: {
        getWorkflowRun: async ({ run_id }) => {
          requests.push({ action: "getWorkflowRun", run_id });
          return { data: run_id === run.id ? run : selectedRun };
        },
        listWorkflowRuns: async args => {
          requests.push({ action: "listWorkflowRuns", args });
          return args.event === "push" ? baseCandidates : prCandidates;
        }
      },
      issues: {
        listComments: async () => [],
        createComment: async args => { writes.push(args); },
        updateComment: async args => { writes.push(args); }
      }
    },
    paginate: (action, args) => action(args)
  };
  const process = {
    env: {
      BENCHMARK_PR_NUMBER: "8",
      TEST_REPORT: "<!-- benchmark-pr-quality-report -->\nBenchmark report",
      BENCHMARK_BASE_SHA: selected ? "base-sha" : "",
      BENCHMARK_BASE_REF: selected ? "main" : "",
      BENCHMARK_BASE_RUN_ID: selected ? "999" : "",
      BENCHMARK_BASE_RUN_ATTEMPT: selected ? "1" : ""
    }
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("github", "context", "core", "process", "policy", script);
  await fn(github, {
    repo: { owner: "affank1020", repo: "benchmark" },
    payload: { workflow_run: run }
  }, { warning: message => warnings.push(message) }, process,
  { matchesRunToPr, isLatestCompletedRun, findOwnedReportComment });
  return { writes, requests, warnings };
}

test("fresh successful base run publishes after rechecking exact attempt and newest run", async () => {
  const { writes, requests } = await attemptPublish();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].issue_number, 8);
  assert.deepEqual(requests.filter(x => x.action === "getWorkflowRun").map(x => x.run_id), [10, 999]);
  const query = requests.find(x => x.action === "listWorkflowRuns" && x.args.event === "push").args;
  assert.equal(query.workflow_id, 300);
  assert.equal(query.branch, "main");
  assert.equal(query.head_sha, "base-sha");
  assert.equal(query.status, "completed");
});

test("rerun of selected base CI attempt cannot publish stale comparison", async () => {
  for (const selectedRun of [
    { ...chosen, run_attempt: 2, conclusion: "failure" },
    { ...chosen, run_attempt: 2, status: "in_progress", conclusion: null },
    { ...chosen, conclusion: "failure" },
    { ...chosen, head_sha: "stale-sha" },
    { ...chosen, head_branch: "another" },
    { ...chosen, repository: { id: 9999 } }
  ]) {
    const { writes } = await attemptPublish({ selectedRun });
    assert.equal(writes.length, 0, JSON.stringify(selectedRun));
  }
});

test("newer completed exact-base push, including a failure, supersedes the selected baseline", async () => {
  for (const newer of [
    { ...chosen, id: 1000, run_number: 17, conclusion: "failure" },
    { ...chosen, id: 1000, run_number: 17, conclusion: "success" },
    { ...chosen, run_attempt: 2, conclusion: "failure" }
  ]) {
    const { writes } = await attemptPublish({ baseCandidates: [chosen, newer] });
    assert.equal(writes.length, 0, JSON.stringify(newer));
  }
});

test("PR retargeting or source CI rerun prevents report publication", async () => {
  for (const options of [
    { currentPr: { ...pr, base: { ...pr.base, sha: "other-sha" } } },
    { currentPr: { ...pr, base: { ...pr.base, ref: "release" } } },
    { currentPr: { ...pr, head: { ...pr.head, sha: "other-head" } } },
    { prCandidates: [{ ...run, run_number: 11, id: 11 }, run] }
  ]) {
    const { writes } = await attemptPublish(options);
    assert.equal(writes.length, 0, JSON.stringify(options));
  }
});

test("a report without any selected baseline still publishes normal CI status", async () => {
  const { writes, requests } = await attemptPublish({ selected: false });
  assert.equal(writes.length, 1);
  assert.equal(requests.some(x => x.action === "listWorkflowRuns" && x.args.event === "push"), false);
});


test("newer queued or running CI attempt cannot let an old report overwrite a waiting/processing state", async () => {
  for (const newer of [
    { ...run, id: 11, run_number: 11, status: "queued", conclusion: null },
    { ...run, id: 11, run_number: 11, status: "in_progress", conclusion: null },
    { ...run, run_attempt: 2, status: "in_progress", conclusion: null }
  ]) {
    const { writes } = await attemptPublish({ prCandidates: [run, newer] });
    assert.equal(writes.length, 0, JSON.stringify(newer));
  }
});
