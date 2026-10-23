import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = new URL("../scripts/verify-release-tag.sh", import.meta.url);
const manifest = new URL("../package.json", import.meta.url);

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
}).trim();

const signedGit = (cwd, ...args) => git(cwd,
  "-c", "user.name=Benchmark Fixture",
  "-c", "user.email=benchmark-fixture@example.invalid", ...args);

const runCheck = (runner, tag, { event = "workflow_dispatch",
  ref = "refs/heads/main", sha = "a".repeat(40) } = {}) =>
  spawnSync("bash", ["scripts/verify-release-tag.sh", tag], {
    cwd: runner, encoding: "utf8", env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: ref,
      GITHUB_REF_TYPE: event === "push" ? "tag" : "branch",
      GITHUB_SHA: sha
    }
  });

// Real bare Git origin + a reviewed main commit *after* the annotated version
// was tagged. This models v0.1.0 recovery without retagging the old commit.
const fixture = async fn => {
  const temp = await mkdtemp(join(tmpdir(), "benchmark-tag-recovery-"));
  const writer = join(temp, "writer");
  const remote = join(temp, "origin.git");
  let counter = 0;
  try {
    await mkdir(writer);
    git(writer, "init", "-q", "-b", "main");
    const packageJson = await readFile(manifest, "utf8");
    const version = JSON.parse(packageJson).version;
    const tag = "v" + version;
    await writeFile(join(writer, "package.json"), packageJson);
    git(writer, "add", "package.json");
    signedGit(writer, "commit", "-qm", "Release source, before policy repair");
    const taggedSha = git(writer, "rev-parse", "HEAD");
    signedGit(writer, "tag", "-a", tag, "-m", "Benchmark test release");
    const tagObject = git(writer, "rev-parse", "refs/tags/" + tag);

    execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
    git(writer, "remote", "add", "origin", remote);
    git(writer, "push", "-q", "origin", "main");
    git(writer, "push", "-q", "origin", "refs/tags/" + tag);

    await mkdir(join(writer, "scripts"));
    await writeFile(join(writer, "scripts/verify-release-tag.sh"),
      await readFile(script));
    git(writer, "add", "scripts/verify-release-tag.sh");
    signedGit(writer, "commit", "-qm", "Fix release verification on main");
    const policySha = git(writer, "rev-parse", "HEAD");
    git(writer, "push", "-q", "origin", "main");

    const clone = () => {
      const runner = join(temp, "checkout-" + ++counter);
      execFileSync("git", ["clone", "-q", "--branch", "main", remote, runner]);
      return runner;
    };
    await fn({ temp, writer, remote, tag, taggedSha, tagObject,
      policySha, version, clone });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
};

test("manual recovery restores an annotated tag shadowed by checkout and uses original tagged code", async () => {
  await fixture(async ({ tag, taggedSha, tagObject, policySha, clone }) => {
    const runner = clone();
    assert.equal(git(runner, "rev-parse", "HEAD"), policySha);
    // Reproduce actions/checkout's tag-event behavior: local tag points at
    // a commit rather than the original annotated tag object.
    git(runner, "update-ref", "refs/tags/" + tag, taggedSha);
    assert.equal(git(runner, "cat-file", "-t", "refs/tags/" + tag), "commit");
    const result = runCheck(runner, tag);
    assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
    assert.equal(git(runner, "cat-file", "-t", "refs/tags/" + tag), "tag");
    assert.equal(git(runner, "rev-parse", "refs/tags/" + tag), tagObject);
    assert.equal(git(runner, "rev-parse", "HEAD"), taggedSha);
    assert.equal(git(runner, "ls-remote", "origin", "refs/tags/" + tag)
      .split("\t")[0], tagObject, "Remote tag must not move");
    assert.equal(existsSync(join(runner, "scripts/verify-release-tag.sh")), false,
      "After verification, the release checkout must be original tagged source");
  });
});

test("tag pushes require exact ref and event SHA, preserving original annotated identity", async () => {
  await fixture(async ({ tag, taggedSha, clone }) => {
    const runner = clone();
    git(runner, "update-ref", "refs/tags/" + tag, taggedSha);
    const good = runCheck(runner, tag, { event: "push",
      ref: "refs/tags/" + tag, sha: taggedSha });
    assert.equal(good.status, 0, good.stderr + "\n" + good.stdout);
    assert.equal(git(runner, "rev-parse", "HEAD"), taggedSha);

    const wrongRunner = clone();
    const wrongSha = runCheck(wrongRunner, tag, { event: "push",
      ref: "refs/tags/" + tag, sha: "0".repeat(40) });
    assert.notEqual(wrongSha.status, 0);
    assert.match(wrongSha.stderr, /pushed release commit does not match/);

    const wrongRef = runCheck(clone(), tag, { event: "push",
      ref: "refs/tags/unrelated", sha: taggedSha });
    assert.notEqual(wrongRef.status, 0);
    assert.match(wrongRef.stderr, /Tag-push identity/);
  });
});

test("recovery rejects other branches, unsupported events, malformed and missing tags", async () => {
  await fixture(async ({ tag, clone, policySha }) => {
    for (const input of [
      { tag, args: { ref: "refs/heads/feature" }, reason: /only permitted.*main/ },
      { tag, args: { event: "pull_request" }, reason: /Unsupported release event/ },
      { tag: "v01.2.3", args: {}, reason: /canonical vX.Y.Z/ },
      { tag: "v1.2.3;echo unsafe", args: {}, reason: /canonical vX.Y.Z/ },
      { tag: "v99.0.0", args: {}, reason: /couldn't find remote ref|not found/i }
    ]) {
      const runner = clone();
      const result = runCheck(runner, input.tag, input.args);
      assert.notEqual(result.status, 0, result.stdout + "\n" + result.stderr);
      assert.match(result.stderr, input.reason);
      assert.equal(git(runner, "rev-parse", "HEAD"), policySha,
        "Rejected input must not switch to unreviewed source");
    }
  });
});

test("lightweight and version-mismatched annotated remote tags fail closed", async () => {
  await fixture(async ({ writer, taggedSha, clone, version }) => {
    const [major, minor, patch] = version.split(".").map(Number);
    const next = "v" + [major, minor, patch + 1].join(".");
    git(writer, "tag", next, taggedSha);
    git(writer, "push", "-q", "origin", "refs/tags/" + next);
    const lightweight = runCheck(clone(), next);
    assert.notEqual(lightweight.status, 0);
    assert.match(lightweight.stderr, /must be annotated/);

    const annotated = "v" + [major, minor, patch + 2].join(".");
    signedGit(writer, "tag", "-a", annotated, taggedSha,
      "-m", "Wrong version on reviewed source");
    git(writer, "push", "-q", "origin", "refs/tags/" + annotated);
    const mismatch = runCheck(clone(), annotated);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /tag does not match.*package\.json/);
  });
});

test("an annotated tag from a commit outside main is never packaged", async () => {
  await fixture(async ({ writer, clone, policySha }) => {
    git(writer, "checkout", "--orphan", "unreviewed");
    git(writer, "rm", "-q", "-rf", ".");
    await writeFile(join(writer, "rogue.txt"), "not on main\n");
    git(writer, "add", ".");
    signedGit(writer, "commit", "-qm", "Unreviewed source");
    signedGit(writer, "tag", "-a", "v8.0.0", "-m", "Outside main");
    git(writer, "push", "-q", "origin", "refs/tags/v8.0.0");

    const runner = clone();
    const rejected = runCheck(runner, "v8.0.0");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /not reachable from reviewed main/);
    assert.equal(git(runner, "rev-parse", "HEAD"), policySha);
  });
});
