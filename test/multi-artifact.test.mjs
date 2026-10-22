import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = path => readFile(new URL(path, import.meta.url), "utf8");
const workflows = [
  "../.github/workflows/benchmark-report.yml",
  "../examples/report-pr.yml",
  "../.github/workflows/reusable-report.yml"
];

function extractScript(yaml, stepName) {
  const start = yaml.indexOf("      - name: " + stepName + "\n");
  assert.ok(start >= 0, "Missing step: " + stepName);
  const end = yaml.indexOf("\n      - name:", start + 1);
  const part = yaml.slice(start, end < 0 ? undefined : end);
  const marker = "          script: |\n";
  const offset = part.indexOf(marker);
  assert.ok(offset >= 0);
  return part.slice(offset + marker.length).split("\n")
    .map(line => line.startsWith("            ") ? line.slice(12) : line).join("\n");
}

async function discover({ artifacts = [], testsName = "benchmark-ci",
  coverageName = "benchmark-ci", workflow = workflows[0] } = {}) {
  const yaml = await load(workflow);
  const script = extractScript(yaml, "Resolve bounded CI artifacts by exact name");
  const outputs = {}, warnings = [], requests = [];
  const github = {
    rest: { actions: {
      listWorkflowRunArtifacts: async args => {
        requests.push(args);
        return artifacts;
      }
    }},
    paginate: (fn, args) => fn(args)
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("github", "context", "core", "process", script)(
    github, { repo: { owner: "org", repo: "consumer" }, payload: { workflow_run: { id: 42 } } },
    { setOutput: (key,value) => { outputs[key] = value; }, warning: x => warnings.push(x) },
    { env: {
      BENCHMARK_TESTS_ARTIFACT_NAME: testsName,
      BENCHMARK_COVERAGE_ARTIFACT_NAME: coverageName
    } }
  );
  return { outputs, warnings, requests };
}

const artifact = (name, id, size = 2048) =>
  ({ name, id, size_in_bytes: size, expired: false });

test("separate jobs select unique bounded artifact IDs from the same CI run", async () => {
  const artifacts = [artifact("ci-junit", 71), artifact("ci-lcov", 72)];
  const result = await discover({ artifacts, testsName: "ci-junit", coverageName: "ci-lcov" });
  assert.deepEqual(result.outputs, { tests_id: "71", coverage_id: "72" });
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].run_id, 42);
  assert.equal(result.requests[0].per_page, 100);

  const onlyTests = await discover({
    artifacts: [artifacts[0]], testsName: "ci-junit", coverageName: "ci-lcov"
  });
  assert.deepEqual(onlyTests.outputs, { tests_id: "71" });
  const onlyCoverage = await discover({
    artifacts: [artifacts[1]], testsName: "ci-junit", coverageName: "ci-lcov"
  });
  assert.deepEqual(onlyCoverage.outputs, { coverage_id: "72" });
});

test("legacy unified artifact remains fully backwards compatible", async () => {
  const r = await discover({ artifacts: [artifact("benchmark-ci", 90)] });
  assert.deepEqual(r.outputs, { tests_id: "90", coverage_id: "90" });
});

test("duplicate, expired, invalid and oversized artifact identities fail closed", async () => {
  const goodCoverage = artifact("ci-lcov", 72);
  const invalid = [
    artifact("ci-junit", 0),
    { ...artifact("ci-junit", 71), id: null },
    { ...artifact("ci-junit", 71), expired: true },
    artifact("ci-junit", 71, 0),
    artifact("ci-junit", 71, 25 * 1024 * 1024 + 1)
  ];
  for (const bad of invalid) {
    const out = await discover({
      artifacts: [bad, goodCoverage], testsName: "ci-junit", coverageName: "ci-lcov"
    });
    assert.deepEqual(out.outputs, { coverage_id: "72" });
    assert.ok(out.warnings.length, JSON.stringify(bad));
  }
  const duplicates = await discover({
    artifacts: [artifact("ci-junit", 71), artifact("ci-junit", 73), goodCoverage],
    testsName: "ci-junit", coverageName: "ci-lcov"
  });
  assert.deepEqual(duplicates.outputs, { coverage_id: "72" });
  for (const name of ["", "a".repeat(129)]) {
    await assert.rejects(discover({
      artifacts: [goodCoverage], testsName: name, coverageName: "ci-lcov"
    }), /Invalid tests artifact name/);
  }
});

test("split inputs have independent ID-based directories across publisher variants", async () => {
  const [installed, example, reusable] = await Promise.all(workflows.map(load));
  for (const yaml of [installed, example, reusable]) {
    const start = yaml.indexOf("      - name: Download exact CI test artifact");
    const end = yaml.indexOf("      - name: Find exact base-branch coverage artifact");
    assert.ok(start >= 0 && end > start);
    const fragment = yaml.slice(start, end);
    assert.match(fragment, /artifact-ids: \$\{\{ steps\.artifact\.outputs\.tests_id \}\}/);
    assert.match(fragment, /artifact-ids: \$\{\{ steps\.artifact\.outputs\.coverage_id \}\}/);
    assert.match(fragment, /path: artifacts\/tests/);
    assert.match(fragment, /path: artifacts\/coverage/);
    assert.equal((fragment.match(/merge-multiple: true/g) ?? []).length, 2);
    assert.doesNotMatch(fragment, /name: benchmark-ci/);
    assert.match(yaml, /--coverage artifacts\/coverage\/lcov\.info/);
    assert.match(yaml, /--tests artifacts\/tests\/junit\.xml/);
    assert.match(yaml, /if: steps\.artifact\.outputs\.tests_id != ''/);
    assert.match(yaml, /if: steps\.artifact\.outputs\.coverage_id != ''/);
  }
  const scripts = [installed, example, reusable].map(
    yaml => extractScript(yaml, "Resolve bounded CI artifacts by exact name")
  );
  assert.equal(scripts[0], scripts[1]);
  assert.equal(scripts[0], scripts[2]);
});

test("reusable inputs separately configure JUnit and exact-base LCOV artifact names", async () => {
  const reusable = await load(workflows[2]);
  assert.match(reusable, /BENCHMARK_TESTS_ARTIFACT_NAME: \$\{\{ inputs\.tests_artifact_name \|\| inputs\.artifact_name \}\}/);
  assert.match(reusable, /BENCHMARK_COVERAGE_ARTIFACT_NAME: \$\{\{ inputs\.coverage_artifact_name \|\| inputs\.artifact_name \}\}/);
  assert.match(reusable, /BENCHMARK_ARTIFACT_NAME: \$\{\{ inputs\.coverage_artifact_name \|\| inputs\.artifact_name \}\}/);
  const tested = await discover({
    artifacts: [artifact("ci-junit", 71), artifact("ci-lcov", 72)],
    testsName: "ci-junit", coverageName: "ci-lcov", workflow: workflows[2]
  });
  assert.deepEqual(tested.outputs, { tests_id: "71", coverage_id: "72" });
});
