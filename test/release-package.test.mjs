import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("../", import.meta.url);
const fixture = async fn => {
  const tmp = await mkdtemp(join(tmpdir(), "benchmark-release-"));
  try { await fn(tmp); } finally { await rm(tmp, { recursive: true, force: true }); }
};
const pack = (version, out) => spawnSync(process.execPath, [
  "scripts/package-release.mjs", "--version", version, "--out-dir", out
], { cwd: root, encoding: "utf8" });
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root, encoding: "utf8"
}).trim();

test("release packaging emits SHA-pinned consumers, an exact CLI archive, manifest and checksums", async () => {
  await fixture(async tmp => {
    const out = join(tmp, "dist");
    const run = pack("v0.1.0", out);
    assert.equal(run.status, 0, run.stderr);
    const files = (await readdir(out)).sort();
    assert.deepEqual(files, [
      "SHA256SUMS", "benchmark-cli-v0.1.0.tar.gz",
      "benchmark-lifecycle.yml", "benchmark-report.yml", "release-manifest.json"
    ]);
    const caller = await readFile(join(out, "benchmark-report.yml"), "utf8");
    const lifecycle = await readFile(join(out, "benchmark-lifecycle.yml"), "utf8");
    assert.ok(caller.includes(
      "uses: affank1020/benchmark/.github/workflows/reusable-report.yml@" + sha
    ));
    assert.match(caller, /workflow_run:\s*\n\s*workflows: \[CI\]/);
    assert.match(lifecycle, /workflow_run:\s*\n\s*workflows: \[CI\]/);
    assert.ok(lifecycle.includes("ref: " + sha + " # Reviewed immutable release commit"));
    assert.doesNotMatch(lifecycle, /pull_request_target:/);
    const active = (v) => v.split("\n").filter(x => !x.trimStart().startsWith("#")).join("\n");
    assert.doesNotMatch(active(caller) + active(lifecycle), /@main|@master|ref: main\b/);
    assert.ok(caller.includes("# Pinned to reviewed Benchmark v0.1.0 release."));
    const manifest = JSON.parse(await readFile(join(out, "release-manifest.json"), "utf8"));
    assert.equal(manifest.version, "v0.1.0");
    assert.equal(manifest.commit, sha);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.requiredNode, ">=22.6.0");
    const checks = (await readFile(join(out, "SHA256SUMS"), "utf8")).trim().split("\n");
    assert.equal(checks.length, 4);
    for (const row of checks) {
      const matched = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/.exec(row);
      assert.ok(matched, "Invalid SHA256SUMS row: " + row);
      const [, digest, name] = matched;
      const bytes = await readFile(join(out, name));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
      if (name !== "release-manifest.json") {
        assert.equal(manifest.assets[name].sha256, digest);
        assert.equal(manifest.assets[name].bytes, bytes.length);
      }
    }
    const entries = execFileSync("tar", [
      "-tzf", join(out, "benchmark-cli-v0.1.0.tar.gz")
    ], { encoding: "utf8" }).trim().split("\n");
    for (const file of [
      "LICENSE", "README.md", "package.json", "src/cli.mjs", "src/core.ts",
      "src/read-input.mjs", "src/publish-policy.mjs"
    ]) assert.ok(entries.includes("benchmark-v0.1.0/" + file), file);
    assert.ok(entries.every(e => e.startsWith("benchmark-v0.1.0/")));
    assert.ok(!entries.some(e => e.includes("/test/") ||
      e.includes("/.github/") || e.includes("node_modules")));
  });
});

test("release packager rejects wrong tags and refuses existing outputs", async () => {
  await fixture(async tmp => {
    for (const tag of ["", "v0.1", "v0.1.1", "v01.1.0", "v../../1", "main", "v1.0.0-rc1"]) {
      const result = pack(tag, join(tmp, "bad-" + String(tag).replace(/[^a-z0-9]/gi, "-")));
      assert.notEqual(result.status, 0, "Unexpectedly accepted " + tag);
    }
    const out = join(tmp, "release");
    assert.equal(pack("v0.1.0", out).status, 0);
    const repeat = pack("v0.1.0", out);
    assert.notEqual(repeat.status, 0);
    assert.match(repeat.stderr, /Output directory must be empty/);
    const preexisting = join(tmp, "occupied");
    await writeFile(preexisting, "taken");
    assert.notEqual(pack("v0.1.0", preexisting).status, 0);
  });
});

test("release workflow publishes only an annotated tag reachable from main", async () => {
  const yaml = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(yaml, /push:\s*\n\s*tags: \["v\*"\]/);
  assert.doesNotMatch(yaml, /pull_request_target:|workflow_run:|workflow_dispatch:/);
  assert.match(yaml, /contents: write/);
  assert.match(yaml, /persist-credentials: false/);
  assert.match(yaml, /git cat-file -t/);
  assert.match(yaml, /git merge-base --is-ancestor HEAD refs\/remotes\/origin\/main/);
  assert.match(yaml, /git rev-parse "refs\/tags\/\$TAG\^\{commit\}"/);
  assert.match(yaml, /package-release\.mjs --version "\$TAG" --out-dir dist/);
  assert.match(yaml, /sha256sum --check SHA256SUMS/);
  assert.match(yaml, /gh release create "\$TAG"/);
  assert.match(yaml, /--verify-tag/);
  assert.match(yaml, /--fail-on-no-commits/);
});

test("consumer example uses the most recently reviewed immutable release", async () => {
  const sample = await readFile(new URL("../examples/use-reusable-report.yml", import.meta.url), "utf8");
  assert.match(sample, /reusable-report\.yml@eb53a1881039fcd53ecce821f327bd0b6990acb8/);
  assert.doesNotMatch(sample.split("\n").filter(x => !x.trimStart().startsWith("#")).join("\n"), /@main|pull_request_target/);
});
