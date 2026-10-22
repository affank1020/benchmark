import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
}).trim();

const pack = (checkout, version, out) => spawnSync(process.execPath, [
  "scripts/package-release.mjs", "--version", version, "--out-dir", out
], { cwd: checkout, encoding: "utf8" });

const nextPatchVersion = version => {
  const [major, minor, patch] = version.split(".").map(Number);
  assert.ok([major, minor, patch].every(Number.isSafeInteger), "Expected a stable SemVer version");
  return [major, minor, patch + 1].join(".");
};

// Test the CURRENT working files (including uncommitted source edits) in a
// separate, clean Git snapshot. A real release must still reject dirty source.
// Never commit/stash/reset the contributor's original checkout.
const fixture = async fn => {
  const tmp = await mkdtemp(join(tmpdir(), "benchmark-release-"));
  const checkout = join(tmp, "checkout");
  try {
    await mkdir(checkout);
    const paths = [...new Set(execFileSync("git", [
      "ls-files", "--cached", "--others", "--exclude-standard", "-z"
    ], { cwd: root }).toString("utf8").split("\0").filter(Boolean))];
    assert.ok(paths.includes("scripts/package-release.mjs"));
    assert.ok(paths.includes("docs/cli-archive.md"));
    for (const path of paths) {
      assert.ok(!isAbsolute(path) && !path.split("/").includes("..") &&
        !path.split("/").includes(".git"), "Unsafe checkout path: " + path);
      const destination = join(checkout, path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(root, path), destination, { dereference: false });
    }
    git(checkout, "init", "-q");
    git(checkout, "add", "-A");
    git(checkout, "-c", "user.name=Benchmark Test", "-c",
      "user.email=benchmark-test@example.invalid", "commit", "-qm", "Fixture snapshot");
    assert.equal(git(checkout, "status", "--porcelain", "--untracked-files=no"), "");

    const manifest = JSON.parse(await readFile(join(checkout, "package.json"), "utf8"));
    await fn({
      tmp, checkout, version: manifest.version, tag: "v" + manifest.version,
      sha: git(checkout, "rev-parse", "HEAD"), packageInfo: manifest
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
};

test("release packaging emits SHA-pinned consumers, an exact CLI archive, manifest and checksums", async () => {
  await fixture(async ({ tmp, checkout, tag, sha, packageInfo }) => {
    const out = join(tmp, "dist");
    const run = pack(checkout, tag, out);
    assert.equal(run.status, 0, run.stderr);
    const archive = "benchmark-cli-" + tag + ".tar.gz";
    const prefix = "benchmark-" + tag + "/";
    const files = (await readdir(out)).sort();
    assert.deepEqual(files, [
      "SHA256SUMS", archive,
      "benchmark-lifecycle.yml", "benchmark-report.yml", "release-manifest.json"
    ].sort());
    const caller = await readFile(join(out, "benchmark-report.yml"), "utf8");
    const lifecycle = await readFile(join(out, "benchmark-lifecycle.yml"), "utf8");
    assert.ok(caller.includes(
      "uses: affank1020/benchmark/.github/workflows/reusable-report.yml@" + sha
    ));
    assert.match(caller, /workflow_run:\s*\n\s*workflows: \[CI\]/);
    assert.match(lifecycle, /workflow_run:\s*\n\s*workflows: \[CI\]/);
    assert.ok(lifecycle.includes("ref: " + sha + " # Reviewed immutable release commit"));
    assert.doesNotMatch(lifecycle, /pull_request_target:/);
    const active = value => value.split("\n").filter(x =>
      !x.trimStart().startsWith("#")).join("\n");
    assert.doesNotMatch(active(caller) + active(lifecycle), /@main|@master|ref: main\b/);
    assert.ok(caller.includes("# Pinned to reviewed Benchmark " + tag + " release."));

    const manifest = JSON.parse(await readFile(join(out, "release-manifest.json"), "utf8"));
    assert.equal(manifest.version, tag);
    assert.equal(manifest.commit, sha);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.requiredNode, packageInfo.engines.node);
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
      "-tzf", join(out, archive)
    ], { encoding: "utf8" }).trim().split("\n");
    for (const file of [
      "LICENSE", "README.md", "package.json", "src/cli.mjs", "src/core.ts",
      "src/read-input.mjs", "src/publish-policy.mjs"
    ]) assert.ok(entries.includes(prefix + file), file);

    const packagedReadme = execFileSync("tar", [
      "-xOzf", join(out, archive), prefix + "README.md"
    ], { encoding: "utf8" });
    const canonicalReadme = await readFile(join(checkout, "docs/cli-archive.md"), "utf8");
    assert.equal(packagedReadme, canonicalReadme,
      "CLI README must come from the tested clean Git snapshot");
    assert.match(packagedReadme, /# Benchmark CLI/);
    assert.match(packagedReadme, /node --experimental-strip-types src\/cli\.mjs/);
    assert.match(packagedReadme, /https:\/\/github\.com\/affank1020\/benchmark\/tree\/main\/examples/);
    assert.doesNotMatch(packagedReadme, /npm test|]\((?:\.?\/)?(?:docs|examples|test)\//);
    assert.ok(!entries.includes(prefix + "docs/cli-archive.md"));
    assert.ok(entries.every(entry => entry.startsWith(prefix)));
    assert.ok(!entries.some(entry => entry.includes("/test/") ||
      entry.includes("/.github/") || entry.includes("node_modules")));
  });
});

test("release packager rejects malformed tags, mismatched versions and occupied outputs", async () => {
  await fixture(async ({ tmp, checkout, version, tag }) => {
    const invalidTags = [
      "", "v0.1", "v01.1.0", "v../../1", "main", "v1.0.0-rc1",
      "v" + nextPatchVersion(version)
    ];
    for (const invalid of invalidTags) {
      const result = pack(checkout, invalid,
        join(tmp, "bad-" + invalid.replace(/[^a-z0-9]/gi, "-")));
      assert.notEqual(result.status, 0, "Unexpectedly accepted " + invalid);
    }
    const out = join(tmp, "release");
    const success = pack(checkout, tag, out);
    assert.equal(success.status, 0, success.stderr);
    const repeat = pack(checkout, tag, out);
    assert.notEqual(repeat.status, 0);
    assert.match(repeat.stderr, /Output directory must be empty/);
    const occupied = join(tmp, "occupied");
    await writeFile(occupied, "taken");
    assert.notEqual(pack(checkout, tag, occupied).status, 0);
  });
});

test("production packager rejects dirty sources while packaging tests still pass in a dirty checkout", async () => {
  await fixture(async ({ tmp, checkout, tag }) => {
    await writeFile(join(checkout, "README.md"),
      "\nLocal uncommitted contributor edit\n", { flag: "a" });
    assert.notEqual(git(checkout, "status", "--porcelain", "--untracked-files=no"), "");
    const blocked = pack(checkout, tag, join(tmp, "dirty-release"));
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Tracked checkout changes would make release assets inconsistent/);

    // Run the same positive packaging test from an intentionally dirty source
    // tree. Its own clean fixture must allow it to pass without committing or
    // stashing the contributor's changes. Select only the positive test so
    // this does not recursively run the full test suite.
    const nested = spawnSync(process.execPath, [
      "--test", "--test-name-pattern=^release packaging emits",
      "test/release-package.test.mjs"
    ], { cwd: checkout, encoding: "utf8" });
    assert.equal(nested.status, 0, nested.stderr + "\n" + nested.stdout);
  });
});

test("release packaging follows a committed package version bump without rewriting tests", async () => {
  await fixture(async ({ tmp, checkout, version, packageInfo }) => {
    const updatedVersion = nextPatchVersion(version);
    await writeFile(join(checkout, "package.json"),
      JSON.stringify({ ...packageInfo, version: updatedVersion }, null, 2) + "\n");
    git(checkout, "add", "package.json");
    git(checkout, "-c", "user.name=Benchmark Test", "-c",
      "user.email=benchmark-test@example.invalid", "commit", "-qm", "Bump fixture version");
    const tag = "v" + updatedVersion;
    const sha = git(checkout, "rev-parse", "HEAD");
    const out = join(tmp, "next-release");
    const result = pack(checkout, tag, out);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(out, "release-manifest.json"), "utf8"));
    assert.equal(manifest.version, tag);
    assert.equal(manifest.commit, sha);
    const archive = "benchmark-cli-" + tag + ".tar.gz";
    const packaged = JSON.parse(execFileSync("tar", [
      "-xOzf", join(out, archive), "benchmark-" + tag + "/package.json"
    ], { encoding: "utf8" }));
    assert.equal(packaged.version, updatedVersion);
    assert.notEqual(tag, "v" + version);
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
  assert.doesNotMatch(sample.split("\n").filter(x =>
    !x.trimStart().startsWith("#")).join("\n"), /@main|pull_request_target/);
});
