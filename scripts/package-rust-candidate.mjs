#!/usr/bin/env node
// Produce review-only native Rust release candidates. This tool does not
// publish a GitHub Release, create tags or modify consumer workflows.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BINARY = 100 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function validateNativeBinary(bytes, platform, arch) {
  if (!["linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error("Unsupported native target");
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 64) {
    throw new Error("Missing or truncated native executable");
  }
  if (platform === "linux") {
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        bytes[4] !== 2 || bytes[5] !== 1 ||
        bytes.readUInt16LE(18) !== (arch === "x64" ? 62 : 183)) {
      throw new Error("Binary ELF architecture does not match native target");
    }
  } else {
    if (!bytes.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) ||
        bytes.readUInt32LE(4) !== (arch === "x64" ? 0x01000007 : 0x0100000c)) {
      throw new Error("Binary Mach-O architecture does not match native target");
    }
  }
}

const git = (...args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
}).trim();

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--out-dir" || args[2] !== "--commit") {
    throw new Error("Usage: package-rust-candidate.mjs --out-dir EMPTY_DIR --commit EXACT_HEAD_SHA");
  }
  const [, outArg, , commit] = args;
  if (!SHA.test(commit) || git("rev-parse", "--verify", "HEAD^{commit}") !== commit) {
    throw new Error("Candidate commit must match the current exact checkout HEAD");
  }
  if (git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error("Candidate source checkout has modified tracked files");
  }

  const platform = process.platform;
  const arch = process.arch;
  const binaryPath = join(root, "target", "release", "benchmark");
  const info = await stat(binaryPath);
  if (!info.isFile() || info.size === 0 || info.size > MAX_BINARY) {
    throw new Error("Binary missing or outside allowed size");
  }
  const binary = await readFile(binaryPath);
  validateNativeBinary(binary, platform, arch);

  const out = resolve(outArg);
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length !== 0) {
    throw new Error("Candidate output directory must be empty");
  }
  const target = platform + "-" + arch;
  const stem = "benchmark-rust-" + commit + "-" + target;
  const archive = stem + ".tar.gz";
  const metadata = stem + ".json";
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = {
    schemaVersion: 1,
    kind: "unreleased-ci-candidate",
    version: "v" + pkg.version,
    commit,
    target,
    rustToolchain: "1.85.1",
    binary: { name: "benchmark", bytes: binary.length, sha256: sha256(binary) }
  };
  const json = JSON.stringify(manifest, null, 2) + "\n";
  const staging = await mkdtemp(join(tmpdir(), "benchmark-native-"));
  try {
    const dir = join(staging, "benchmark-rust");
    await mkdir(dir);
    await copyFile(binaryPath, join(dir, "benchmark"));
    await writeFile(join(dir, "manifest.json"), json, { flag: "wx" });
    await writeFile(join(dir, "README.md"), [
      "# Benchmark Rust CI candidate",
      "",
      "This is a **non-release**, built from a reviewable Git commit.",
      "The executable reports on existing LCOV/JUnit/Jest data; it does not run tests.",
      "Verify the archive SHA256 and manifest commit/target before execution.",
      "Official GitHub Release publication and consumer rollout are separate decisions.",
      ""
    ].join("\n"), { flag: "wx" });
    // A fixed directory name and fixed file selection prevent path traversal.
    execFileSync("tar", ["-czf", join(out, archive), "-C", staging, "benchmark-rust"], {
      cwd: root, stdio: "pipe"
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await writeFile(join(out, metadata), json, { flag: "wx" });
  const names = [archive, metadata].sort();
  const checksums = [];
  for (const file of names) {
    const bytes = await readFile(join(out, file));
    checksums.push(sha256(bytes) + "  " + file);
  }
  await writeFile(join(out, "SHA256SUMS"), checksums.join("\n") + "\n", { flag: "wx" });
  process.stdout.write("Created unreleased Rust CI candidate: " + stem + "\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
