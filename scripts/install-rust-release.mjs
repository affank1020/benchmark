#!/usr/bin/env node
// Offline, fail-closed installation of caller-supplied Rust release-format assets.
// Checksums do not authenticate origin. Never downloads or executes the binary.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const supported = ["linux-x64", "darwin-arm64", "darwin-x64"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const stableVersion = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitHash = /^[a-f0-9]{40}$/;
const checksumRow = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/;

async function checkedRegular(path, maxBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.size === 0 || info.size > maxBytes) {
    throw new Error("Missing, oversized or non-regular release file: " + path);
  }
  return readFile(path);
}

export async function installVerifiedRustRelease({ assetsDir, destination, version, commit, target = process.platform + "-" + process.arch }) {
  if (!stableVersion.test(version) || version === "v0.1.0" || !commitHash.test(commit)) {
    throw new Error("Expected an exact reviewed Rust release version and 40-character source commit");
  }
  if (!supported.includes(target) || target !== process.platform + "-" + process.arch) {
    throw new Error("Unsupported or non-native release target");
  }
  const dir = resolve(assetsDir);
  if (!(await lstat(dir)).isDirectory()) {
    throw new Error("Release asset directory must be a real directory, not a symlink");
  }
  const stem = "benchmark-rust-" + commit + "-" + target;
  const archiveName = stem + ".tar.gz";
  const manifestName = stem + ".json";
  const names = ["rust-SHA256SUMS", archiveName, manifestName].sort();
  const actual = (await readdir(dir)).sort();
  if (JSON.stringify(names) !== JSON.stringify(actual)) {
    throw new Error("Expected exactly the pinned release checksum, archive and manifest assets");
  }

  const lines = (await checkedRegular(join(dir, "rust-SHA256SUMS"), 8192))
    .toString("utf8").trimEnd().split("\n");
  const digests = new Map();
  for (const line of lines) {
    const parsed = checksumRow.exec(line);
    if (!parsed || digests.has(parsed[2])) throw new Error("Malformed or duplicate release checksum");
    digests.set(parsed[2], parsed[1]);
  }
  const expected = supported.flatMap(platform => {
    const prefix = "benchmark-rust-" + commit + "-" + platform;
    return [prefix + ".tar.gz", prefix + ".json"];
  }).sort();
  if (JSON.stringify([...digests.keys()].sort()) !== JSON.stringify(expected)) {
    throw new Error("Release checksum inventory does not match exactly three supported platforms");
  }
  const archive = await checkedRegular(join(dir, archiveName), 100 * 1024 * 1024);
  const manifestBytes = await checkedRegular(join(dir, manifestName), 16384);
  if (sha256(archive) !== digests.get(archiveName) ||
      sha256(manifestBytes) !== digests.get(manifestName)) {
    throw new Error("Official release checksum mismatch");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.kind !== "rust-release" || manifest.commit !== commit ||
      manifest.version !== version || manifest.target !== target) {
    throw new Error("Official release manifest does not match the reviewed tag, commit and native target");
  }

  // Reuse the hardened archive verifier (entry types and executable mode,
  // ELF/Mach-O CPU type, embedded manifest identity and binary SHA256).
  const temp = await mkdtemp(join(tmpdir(), "benchmark-release-verify-"));
  let binary;
  try {
    await copyFile(join(dir, archiveName), join(temp, archiveName));
    await copyFile(join(dir, manifestName), join(temp, manifestName));
    await writeFile(join(temp, "SHA256SUMS"),
      [archiveName, manifestName].sort()
        .map(name => digests.get(name) + "  " + name).join("\n") + "\n",
      { flag: "wx" });
    execFileSync(process.execPath, [
      join(scriptDir, "verify-rust-candidate.mjs"),
      "--out-dir", temp, "--commit", commit, "--target", target,
      "--kind", "rust-release"
    ], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 });
    binary = execFileSync("tar", ["-xOf", join(temp, archiveName), "benchmark-rust/benchmark"], {
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 100 * 1024 * 1024
    });
    if (binary.length !== manifest.binary.bytes ||
        sha256(binary) !== manifest.binary.sha256) {
      throw new Error("Installed binary would differ from its reviewed manifest");
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  const out = resolve(destination);
  // Exclusively create a new directory; never overwrite an existing binary,
  // even when the destination appears empty.
  await mkdir(out, { recursive: false, mode: 0o700 });
  try {
    const binaryPath = join(out, "benchmark");
    await writeFile(binaryPath, binary, { flag: "wx", mode: 0o755 });
    await chmod(binaryPath, 0o755);
    const receipt = {
      version, commit, target, binarySha256: sha256(binary),
      source: "Caller-supplied offline assets; origin not authenticated"
    };
    await writeFile(join(out, "installation.json"), JSON.stringify(receipt, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    process.stdout.write("Verified Rust Benchmark " + version + " (" + commit +
      ", " + target + ") into " + out + "\n");
    return receipt;
  } catch (error) {
    await rm(out, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 8 ||
      args[0] !== "--assets-dir" || args[2] !== "--version" ||
      args[4] !== "--commit" || args[6] !== "--dest" ||
      args.some(value => value === "")) {
    throw new Error("Usage: install-rust-release.mjs --assets-dir DIR --version vX.Y.Z --commit REVIEWED_SHA --dest NEW_DIR");
  }
  await installVerifiedRustRelease({
    assetsDir: args[1], version: args[3], commit: args[5], destination: args[7]
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
