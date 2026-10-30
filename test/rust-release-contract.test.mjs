import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = path => readFile(new URL(path, import.meta.url), "utf8");

test("official Rust publisher is manually gated and separates read-only builders from writer", async () => {
  const y = await load("../.github/workflows/rust-release.yml");
  assert.match(y, /workflow_dispatch:\s*\n\s*inputs:/);
  assert.doesNotMatch(y, /^\s*(?:pull_request|pull_request_target|push|workflow_run):/m);
  assert.match(y, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(y, /permissions:\s*\n\s*contents: read/);
  const verify = y.slice(y.indexOf("  verify-tag:"), y.indexOf("  build-native:"));
  const build = y.slice(y.indexOf("  build-native:"), y.indexOf("  publish:"));
  const publish = y.slice(y.indexOf("  publish:"));
  assert.match(verify, /bash scripts\/verify-release-tag\.sh "\$TAG"/);
  assert.match(verify, /gh release view "\$TAG"/);
  assert.match(verify, /test "\$TAG" != v0\.1\.0/);
  assert.match(verify, /source_sha=\$\(git rev-parse HEAD\)/);
  assert.doesNotMatch(verify + build, /contents: write|gh release upload|gh release create/);
  assert.match(build, /permissions:\s*\n\s*contents: read/);
  assert.match(build, /ref: \$\{\{ needs\.verify-tag\.outputs\.source_sha \}\}/);
  assert.match(build, /persist-credentials: false/);
  assert.match(build, /macos-15-intel/);
  assert.match(build, /macos-15/);
  assert.match(build, /ubuntu-24\.04/);
  assert.match(build, /cargo \+1\.85\.1 test --locked --all-targets/);
  assert.match(build, /--kind rust-release/);
  assert.match(build, /actions\/upload-artifact@v4/);
  assert.match(publish, /needs: \[verify-tag, build-native\]/);
  assert.match(publish, /contents: write/);
  assert.match(publish, /actions: read/);
  assert.match(publish, /bash scripts\/verify-release-tag\.sh "\$TAG"/);
  assert.match(publish, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/);
  assert.match(publish, /name: rust-release-linux-x64/);
  assert.match(publish, /name: rust-release-darwin-arm64/);
  assert.match(publish, /name: rust-release-darwin-x64/);
  assert.match(publish, /--target "\$target" --kind rust-release/);
  assert.match(publish, /m.version !== process.env.TAG/);
  assert.match(publish, /rust-SHA256SUMS/);
  assert.match(publish, /gh release upload "\$TAG"/);
  assert.doesNotMatch(publish, /--clobber|gh release create|git push|git tag|bash rust-assets|node rust-assets/);
});

test("v0.1.0 Node release flow remains independent and never imports PR candidates", async () => {
  const [nodeRelease, rustRelease, candidate, packageSource] = await Promise.all([
    load("../.github/workflows/release.yml"),
    load("../.github/workflows/rust-release.yml"),
    load("../.github/workflows/rust-binary-candidates.yml"),
    load("../scripts/package-rust-candidate.mjs")
  ]);
  assert.match(nodeRelease, /gh release create "\$TAG"/);
  assert.match(nodeRelease, /benchmark-cli-\$TAG\.tar\.gz/);
  assert.doesNotMatch(nodeRelease, /rust-release-|rust-candidate-|package-rust-candidate/);
  assert.doesNotMatch(rustRelease, /rust-candidate-|workflow_run|pull_request:/);
  assert.match(candidate, /contents: read/);
  assert.doesNotMatch(candidate, /contents: write|workflow_dispatch|gh release upload/);
  assert.match(candidate, /deliberately stale previous build/);
  assert.match(packageSource, /"--target-dir", build/);
  assert.match(packageSource, /kind = args.length === 6 \? "rust-release" : "unreleased-ci-candidate"/);
});
