import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { matchesRunToPr } from "../src/publish-policy.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const load = path => readFile(new URL(path, import.meta.url), "utf8");

function extractScript(workflow, stepName) {
  const marker = "      - name: " + stepName + "\n";
  const begin = workflow.indexOf(marker);
  assert.notEqual(begin, -1, "Missing workflow step: " + stepName);
  const end = workflow.indexOf("\n      - name:", begin + marker.length);
  const step = workflow.slice(begin, end < 0 ? undefined : end);
  const scriptMarker = "          script: |\n";
  const scriptStart = step.indexOf(scriptMarker);
  assert.notEqual(scriptStart, -1, "Missing github-script: " + stepName);
  return step.slice(scriptStart + scriptMarker.length).split("\n")
    .map(line => line.startsWith("            ") ? line.slice(12) : line)
    .join("\n");
}

const SOURCE_REPO_ID = 110, BASE_REPO_ID = 220;
const run = {
  id: 10, workflow_id: 300, event: "pull_request",
  head_sha: "pr-sha", head_branch: "feature",
  head_repository: { id: SOURCE_REPO_ID }
};
const pr = {
  number: 8, state: "open",
  head: { sha: "pr-sha", ref: "feature", repo: { id: SOURCE_REPO_ID } },
  base: {
    sha: "base-sha", ref: "main",
    repo: { id: BASE_REPO_ID, full_name: "affank1020/benchmark" }
  }
};
const exact = {
  id: 999, workflow_id: run.workflow_id, event: "push", status: "completed",
  conclusion: "success", head_sha: pr.base.sha, head_branch: "main",
  run_number: 16, run_attempt: 1, repository: { id: BASE_REPO_ID }
};
const artifact = {
  id: 400, name: "benchmark-ci", size_in_bytes: 1024, expired: false
};

async function choose({ pull = pr, candidates = [exact], artifacts = [artifact],
                        sourceRun = run, repoId = BASE_REPO_ID,
                        artifactName = "benchmark-ci" } = {}) {
  const workflow = await load("../.github/workflows/benchmark-report.yml");
  let script = extractScript(workflow, "Find exact base-branch coverage artifact");
  // Inject the *actual* trusted pure policy without copying checkout files.
  script = script.replace(
    "const { pathToFileURL } = require('url');\n" +
    "const policy = await import(pathToFileURL(\n" +
    "  process.env.GITHUB_WORKSPACE + '/benchmark/src/publish-policy.mjs'\n" +
    ").href);\n", ""
  );
  const outputs = {};
  const requests = [];
  const github = {
    rest: {
      pulls: { get: async args => {
        requests.push({ api: "pulls.get", args });
        return { data: pull };
      }},
      actions: {
        listWorkflowRuns: async args => {
          requests.push({ api: "listWorkflowRuns", args });
          return candidates;
        },
        listWorkflowRunArtifacts: async args => {
          requests.push({ api: "listWorkflowRunArtifacts", args });
          return artifacts;
        }
      }
    },
    paginate: (method, args) => method(args)
  };
  const context = {
    repo: { owner: "affank1020", repo: "benchmark" },
    payload: { workflow_run: sourceRun, repository: { id: repoId } }
  };
  const core = {
    setOutput: (key, val) => { outputs[key] = val; },
    notice: () => {}, warning: () => {}
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("github", "context", "core", "process", "policy", script);
  await fn(github, context, core, {
    env: { BENCHMARK_PR_NUMBER: "8", BENCHMARK_ARTIFACT_NAME: artifactName }
  }, { matchesRunToPr });
  return { outputs, requests };
}

test("selects the exact successful base-branch push run and bounded artifact", async () => {
  const result = await choose();
  assert.deepEqual(result.outputs, {
    present: "true", run_id: "999", run_attempt: "1",
    artifact_id: "400", base_sha: "base-sha", base_ref: "main"
  });
  const query = result.requests.find(r => r.api === "listWorkflowRuns").args;
  assert.equal(query.head_sha, "base-sha");
  assert.equal(query.branch, "main");
  assert.equal(query.workflow_id, run.workflow_id);
  assert.equal(query.event, "push");
  assert.equal(query.status, "completed");
  assert.equal(result.requests.find(r => r.api === "listWorkflowRunArtifacts").args.run_id, 999);
});

test("rejects stale, untrusted, non-push, and mismatched workflow candidates", async () => {
  const invalid = [
    { ...exact, head_sha: "another-sha" },
    { ...exact, repository: { id: 1234 } },
    { ...exact, workflow_id: 777 },
    { ...exact, head_branch: "develop" },
    { ...exact, event: "pull_request" },
    { ...exact, status: "in_progress" },
    { ...exact, run_attempt: null }
  ];
  for (const candidate of invalid) {
    const { outputs, requests } = await choose({ candidates: [candidate] });
    assert.deepEqual(outputs, {}, JSON.stringify(candidate));
    assert.equal(requests.some(r => r.api === "listWorkflowRunArtifacts"), false);
  }
});

test("newest exact base run failing prevents falling back to an older success", async () => {
  const newest = { ...exact, id: 1000, run_number: 17, conclusion: "failure" };
  const { outputs, requests } = await choose({ candidates: [exact, newest] });
  assert.deepEqual(outputs, {});
  assert.equal(requests.some(r => r.api === "listWorkflowRunArtifacts"), false);
});

test("rejects changed PR heads and mismatched base repository identity", async () => {
  for (const options of [
    { pull: { ...pr, state: "closed" } },
    { pull: { ...pr, head: { ...pr.head, sha: "new-head" } } },
    { pull: { ...pr, base: { ...pr.base, repo: { id: 999 } } } },
    { repoId: 999 }
  ]) {
    const { outputs, requests } = await choose(options);
    assert.deepEqual(outputs, {});
    assert.equal(requests.some(r => r.api === "listWorkflowRuns"), false);
  }
});

test("expired or oversized artifact fails closed and custom artifact names match exactly", async () => {
  for (const artifacts of [
    [{ ...artifact, expired: true }],
    [{ ...artifact, size_in_bytes: 25 * 1024 * 1024 + 1 }],
    [{ ...artifact, size_in_bytes: 0 }],
    [{ ...artifact, name: "an-unrelated-name" }],
    []
  ]) {
    assert.deepEqual((await choose({ artifacts })).outputs, {});
  }
  const customized = await choose({
    artifactName: "custom-benchmark",
    artifacts: [{ ...artifact, name: "custom-benchmark" }]
  });
  assert.equal(customized.outputs.run_id, "999");
});

test("duplicate same-name artifacts fail closed even if one is within size limits", async () => {
  const { outputs } = await choose({ artifacts: [
    artifact,
    { ...artifact, id: 401, size_in_bytes: 26 * 1024 * 1024 }
  ] });
  assert.deepEqual(outputs, {});
  const expired = await choose({ artifacts: [
    artifact,
    { ...artifact, id: 402, expired: true }
  ] });
  assert.deepEqual(expired.outputs, {});
});

test("validated artifact ID is returned exactly, never selected again by name", async () => {
  const candidate = { ...artifact, id: 777, size_in_bytes: 2048 };
  const { outputs } = await choose({ artifacts: [candidate] });
  assert.equal(outputs.artifact_id, "777");
  assert.equal(outputs.run_id, "999");
  assert.equal(outputs.run_attempt, "1");
  assert.deepEqual((await choose({ artifacts: [{ ...candidate, id: null }] })).outputs, {});
});

test("publisher only passes a downloaded baseline and rechecks its base SHA at publication", async () => {
  const installed = await load("../.github/workflows/benchmark-report.yml");
  assert.match(installed, /if: steps\.baseline\.outputs\.present == 'true'/);
  assert.match(installed, /run-id: \$\{\{ steps\.baseline\.outputs\.run_id \}\}/);
  assert.match(installed, /artifact-ids: \$\{\{ steps\.baseline\.outputs\.artifact_id \}\}/);
  const downloaded = installed.slice(
    installed.indexOf("- name: Download exact base CI artifact"),
    installed.indexOf("- name: Generate quality report")
  );
  assert.doesNotMatch(downloaded, /\n\s*name: benchmark-ci/);
  assert.match(installed, /path: baseline/);
  assert.match(installed, /if \[ -f baseline\/lcov\.info \]; then[\s\S]*?baseline_args=\(--baseline-coverage baseline\/lcov\.info\)/);
  assert.match(installed, /"\$\{baseline_args\[@\]\}"/);
  assert.match(installed, /BENCHMARK_BASE_SHA: \$\{\{ steps\.baseline\.outputs\.base_sha \}\}/);
  assert.match(installed, /BENCHMARK_BASE_REF: \$\{\{ steps\.baseline\.outputs\.base_ref \}\}/);
  assert.match(installed, /BENCHMARK_BASE_RUN_ID: \$\{\{ steps\.baseline\.outputs\.run_id \}\}/);
  assert.match(installed, /BENCHMARK_BASE_RUN_ATTEMPT: \$\{\{ steps\.baseline\.outputs\.run_attempt \}\}/);
  assert.match(installed, /current\.base\?\.ref !== process\.env\.BENCHMARK_BASE_REF/);
  assert.match(installed, /current\.base\?\.sha !== process\.env\.BENCHMARK_BASE_SHA/);
  assert.doesNotMatch(installed, /checkout[\s\S]{0,100}ref: \$\{\{/);
});

function assertBaselineExtractsToExpectedRoot(workflow) {
  const start = workflow.indexOf("      - name: Download exact base CI artifact");
  const end = workflow.indexOf("      - name: Generate quality report", start);
  assert.ok(start >= 0 && end > start, "Expected a separate ID-based baseline download step");
  const download = workflow.slice(start, end);
  assert.match(download, /uses: actions\/download-artifact@v4/);
  assert.match(download, /artifact-ids: \$\{\{ steps\.baseline\.outputs\.artifact_id \}\}/);
  // download-artifact v4 treats artifact-ids as a multi-artifact path, even
  // for a single ID. Without merge-multiple it creates baseline/<name>/.
  assert.match(download, /^\s+merge-multiple: true\s*$/m);
  assert.match(download, /^\s+path: baseline\s*$/m);
  assert.doesNotMatch(download, /^\s+(?:name|pattern):/m);
  assert.match(workflow, /if \[ -f baseline\/lcov\.info \]; then/);
  assert.match(workflow, /baseline_args=\(--baseline-coverage baseline\/lcov\.info\)/);
}

test("ID-based artifact download extracts at baseline/lcov.info in every publisher", async () => {
  for (const path of [
    "../.github/workflows/benchmark-report.yml",
    "../examples/report-pr.yml",
    "../.github/workflows/reusable-report.yml"
  ]) {
    const workflow = await load(path);
    assertBaselineExtractsToExpectedRoot(workflow);
    assert.throws(
      () => assertBaselineExtractsToExpectedRoot(workflow.replace(
        "          merge-multiple: true\n          path: baseline",
        "          merge-multiple: false\n          path: baseline"
      )),
      /merge-multiple: true/,
      path + " must detect the default nested extraction failure"
    );
  }
});

test("installed and public full workflow remain synchronized; reusable variant uses its input", async () => {
  const [installed, full, reusable] = await Promise.all([
    load("../.github/workflows/benchmark-report.yml"),
    load("../examples/report-pr.yml"),
    load("../.github/workflows/reusable-report.yml")
  ]);
  assert.equal(installed.replace(
    "# Dogfood Benchmark's trusted publisher on Benchmark pull requests.\n" +
    "# Keep this workflow in sync with examples/report-pr.yml until integration is packaged.",
    "# Copy this file to .github/workflows/benchmark-report.yml in a consuming repo.\n" +
    "# Edit 'workflows: [CI]' to the exact name of the existing PR CI workflow."
  ), full);
  for (const workflow of [installed, full, reusable]) {
    assert.match(workflow, /Find exact base-branch coverage artifact/);
    assert.match(workflow, /candidate\.head_sha === base\.sha/);
    assert.match(workflow, /candidate\.event === 'push'/);
    assert.match(workflow, /candidate\.repository\?\.id === base\.repo\.id/);
    assert.match(workflow, /candidate\.workflow_id === run\.workflow_id/);
    assert.match(workflow, /latest\.conclusion !== 'success'/);
    assert.match(workflow, /source\.size_in_bytes > 25 \* 1024 \* 1024/);
    assert.match(workflow, /artifact-ids: \$\{\{ steps\.baseline\.outputs\.artifact_id \}\}/);
    assert.match(workflow, /BENCHMARK_BASE_RUN_ATTEMPT:/);
    assert.match(workflow, /latest\.run_attempt !== selectedAttempt/);
    assert.match(workflow, /ref: 81b6602198c38a74d6b539a484ff25b86c8e0cc8/);
    assert.match(workflow, /BENCHMARK_BASE_SHA:/);
  }
  assert.match(reusable, /BENCHMARK_ARTIFACT_NAME: \$\{\{ inputs\.artifact_name \}\}/);
  assert.match(reusable, /name: \$\{\{ inputs\.artifact_name \}\}/);
  assert.equal(
    extractScript(reusable, "Find exact base-branch coverage artifact"),
    extractScript(installed, "Find exact base-branch coverage artifact")
  );
});
