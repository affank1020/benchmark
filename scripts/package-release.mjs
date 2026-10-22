#!/usr/bin/env node
// Package a reviewed Git commit and generate SHA-pinned consumer workflows.
// No network calls or dependency installation; this never creates a release.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--version" || args[2] !== "--out-dir") {
  throw new Error("Usage: package-release.mjs --version vX.Y.Z --out-dir DIRECTORY");
}
const tag = args[1];
if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag)) {
  throw new Error("Release tag must be an exact stable vX.Y.Z version");
}
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (tag !== "v" + manifest.version) {
  throw new Error("Release tag must equal v + package.json version (" + manifest.version + ")");
}
const git = (...args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
}).trim();
const sha = git("rev-parse", "--verify", "HEAD^{commit}");
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Expected a complete commit SHA");
if (git("status", "--porcelain", "--untracked-files=no")) {
  throw new Error("Tracked checkout changes would make release assets inconsistent with the pin");
}
const out = resolve(args[3]);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) {
  throw new Error("Output directory must be empty; refusing to overwrite release assets");
}

function pinExactlyOnce(source, pattern, replacement, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error("Expected exactly one reviewed SHA pin for " + label);
  }
  return source.replace(pattern, replacement);
}

const caller = await readFile(join(root, "examples/use-reusable-report.yml"), "utf8");
const pinnedCaller = pinExactlyOnce(
  caller,
  /((?:uses:\s*)affank1020\/benchmark\/\.github\/workflows\/reusable-report\.yml@)[0-9a-f]{40}\b/g,
  (_, prefix) => prefix + sha,
  "consumer reporter"
);
const releaseCaller = pinnedCaller.replace(
  /^# Pinned to reviewed Benchmark PR #\d+ merge\. Deliberately upgrade only$/m,
  "# Pinned to reviewed Benchmark " + tag + " release. Deliberately upgrade only"
);
const lifecycle = await readFile(join(root, "examples/lifecycle-pr.yml"), "utf8");
const pinnedLifecycle = pinExactlyOnce(
  lifecycle,
  /(\brepository: affank1020\/benchmark\s*\n\s*ref: )[0-9a-f]{40}[^\n]*/g,
  (_, prefix) => prefix + sha + " # Reviewed immutable release commit",
  "early-status matcher"
);
// Safety checks must inspect executable YAML, not comments explaining
// why mutable refs and the untrusted event type are forbidden.
const activeYaml = value => value.split("\n").filter(line =>
  !line.trimStart().startsWith("#")
).join("\n");
const activeCaller = activeYaml(releaseCaller);
const activeLifecycle = activeYaml(pinnedLifecycle);
if (!activeCaller.includes("workflow_run:") ||
    !activeLifecycle.includes("workflow_run:") ||
    activeLifecycle.includes("pull_request_target:") ||
    /\buses:\s*[^\n]*@(?:main|master)\b/.test(activeCaller) ||
    /\bref:\s*(?:main|master)\b/.test(activeLifecycle)) {
  throw new Error("Consumer templates must use trusted workflow_run and immutable code");
}

const archive = "benchmark-cli-" + tag + ".tar.gz";
const files = ["benchmark-report.yml", "benchmark-lifecycle.yml", archive];
await writeFile(join(out, files[0]), releaseCaller, { flag: "wx" });
await writeFile(join(out, files[1]), pinnedLifecycle, { flag: "wx" });
// Use a CLI-specific README from the reviewed commit, not the source
// README, which refers to docs and tests not shipped in the archive.
// git archive --add-file joins the prefix with the added file basename.
const staging = await mkdtemp(join(tmpdir(), "benchmark-cli-readme-"));
try {
  const archivedReadme = git("show", sha + ":docs/cli-archive.md") + "\n";
  const readmeFile = join(staging, "README.md");
  await writeFile(readmeFile, archivedReadme, { flag: "wx" });
  // Every shipped byte originates from the same reviewed Git commit.
  execFileSync("git", [
    "archive", "--format=tar.gz", "--prefix=benchmark-" + tag + "/",
    "--add-file=" + readmeFile,
    "--output=" + join(out, archive), sha,
    "LICENSE", "package.json",
    "src/cli.mjs", "src/core.ts", "src/read-input.mjs", "src/publish-policy.mjs"
  ], { cwd: root, stdio: "pipe" });
} finally {
  await rm(staging, { recursive: true, force: true });
}

const digest = async file => {
  const bytes = await readFile(join(out, file));
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length
  };
};
const assets = {};
for (const name of files) assets[name] = await digest(name);
const manifestName = "release-manifest.json";
await writeFile(join(out, manifestName),
  JSON.stringify({
    schemaVersion: 1,
    version: tag,
    commit: sha,
    requiredNode: manifest.engines.node,
    assets
  }, null, 2) + "\n",
  { flag: "wx" }
);
const names = [...files, manifestName].sort();
const checksums = [];
for (const name of names) {
  checksums.push((await digest(name)).sha256 + "  " + name);
}
await writeFile(join(out, "SHA256SUMS"), checksums.join("\n") + "\n", { flag: "wx" });
process.stdout.write("Packaged " + tag + " at " + sha + " into " + out + "\n");
