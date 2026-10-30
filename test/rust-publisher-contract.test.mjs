import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = path => readFile(new URL(path, import.meta.url), "utf8");
const publishers = [
  "../.github/workflows/benchmark-report.yml",
  "../.github/workflows/reusable-report.yml",
  "../examples/report-pr.yml"
];
const policyRef = "81b6602198c38a74d6b539a484ff25b86c8e0cc8";
const rustRef = "ed03341fd34abf651a859a8dc8780ca596484856";

function step(yaml, title) {
  const marker = "      - name: " + title + "\n";
  const begin = yaml.indexOf(marker);
  assert.ok(begin >= 0, "Missing step " + title);
  const end = yaml.indexOf("\n      - name:", begin + marker.length);
  return yaml.slice(begin, end < 0 ? undefined : end);
}

test("every trusted publisher compiles the exact pinned Rust reporter with no PR-controlled checkout", async () => {
  const sources = await Promise.all(publishers.map(load));
  for (const yaml of sources) {
    const policy = step(yaml, "Checkout trusted Benchmark implementation");
    const checkout = step(yaml, "Checkout pinned Rust reporter source");
    const install = step(yaml, "Install pinned Rust toolchain for reporting");
    const build = step(yaml, "Build pinned Rust reporter");
    const report = step(yaml, "Generate quality report (even after CI failure)");
    assert.match(policy, new RegExp("ref: " + policyRef));
    assert.match(policy, /path: benchmark\n\s*persist-credentials: false/);
    assert.match(checkout, new RegExp("ref: " + rustRef));
    assert.match(checkout, /repository: affank1020\/benchmark/);
    assert.match(checkout, /path: benchmark-rust\n\s*persist-credentials: false/);
    for (const guarded of [checkout, install, build, report]) {
      assert.match(guarded, /if: steps\.pr\.outputs\.number != ''/,
        "Only a verified PR may trigger Rust reporting work");
    }
    assert.match(install, /rustup toolchain install 1\.85\.1 --profile minimal/);
    assert.match(build, /cargo \+1\.85\.1 build --locked --release --manifest-path benchmark-rust\/Cargo\.toml --bin benchmark/);
    assert.match(report, /^\s*benchmark-rust\/target\/release\/benchmark \\/m);
    assert.doesNotMatch(report, /node --experimental-strip-types|cargo|rustup|git /);
    assert.match(report, /--coverage artifacts\/coverage\/lcov\.info/);
    assert.match(report, /--tests artifacts\/tests\/junit\.xml/);
    assert.match(report, /--ci "\$CI_CONCLUSION"/);
    assert.match(report, /--output benchmark-report\.md/);
    assert.match(report, /--baseline-coverage baseline\/lcov\.info/);
    assert.ok(yaml.indexOf("Resolve current PR safely") < yaml.indexOf("Checkout pinned Rust reporter source"));
    assert.ok(yaml.indexOf("Build pinned Rust reporter") < yaml.indexOf("Generate quality report (even after CI failure)"));
    assert.ok(yaml.indexOf("Generate quality report (even after CI failure)") < yaml.indexOf("Update one PR comment if still current"));
    if (yaml === sources[1]) {
      assert.match(yaml, /workflow_call:/, "Reusable publisher must be callable");
    } else {
      assert.match(yaml, /workflow_run:[\s\S]*?types: \[completed\]/);
    }
    assert.match(yaml, /queue: max\n\s*cancel-in-progress: false/);
    assert.doesNotMatch(yaml, /pull_request_target/);
    assert.doesNotMatch(yaml, /ref: (?:main|master|HEAD|\$\{\{)/);
    assert.match(yaml, /policy\.matchesRunToPr\(run, current\)/);
    assert.match(yaml, /policy\.isLatestCompletedRun/);
    assert.match(yaml, /benchmark-ci-run:/);
    assert.match(yaml, /Replace stuck processing status on failure/);
    assert.match(yaml, /Reconcile skipped or interrupted processing status/);
    // The publisher must never execute a consumer PR's artifacts as code.
    assert.doesNotMatch(yaml, /run: .*artifacts\/|bash artifacts\/|node artifacts\//);
  }

  const select = yaml => [
    step(yaml, "Checkout pinned Rust reporter source"),
    step(yaml, "Install pinned Rust toolchain for reporting"),
    step(yaml, "Build pinned Rust reporter"),
    step(yaml, "Generate quality report (even after CI failure)")
  ];
  assert.deepEqual(select(sources[0]), select(sources[1]), "Reusable publisher must use identical Rust build and report steps");
  assert.deepEqual(select(sources[0]), select(sources[2]), "Consumer example must use identical Rust build and report steps");
});

test("consumer short caller and CI-start lifecycle retain their old immutable pins", async () => {
  const [caller, lifecycle, example] = await Promise.all([
    load("../examples/use-reusable-report.yml"),
    load("../.github/workflows/benchmark-lifecycle.yml"),
    load("../examples/lifecycle-pr.yml")
  ]);
  assert.match(caller, /@eb53a1881039fcd53ecce821f327bd0b6990acb8/);
  for (const src of [lifecycle, example]) {
    assert.match(src, /ref: 49710ea637eb1af286405451d212b3f836b66c6a/);
    assert.doesNotMatch(src, /benchmark-rust|cargo|rustup/);
  }
});
