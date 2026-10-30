#!/usr/bin/env node
// Check an unreleased Rust candidate's exact source, target, archive and bytes.
// Verification reads release candidates; it does NOT execute their binaries.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateNativeBinary } from "./package-rust-candidate.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const args = process.argv.slice(2);
  if (![4, 6, 8].includes(args.length) || args[0] !== "--out-dir" ||
      args[2] !== "--commit" || !/^[0-9a-f]{40}$/.test(args[3])) {
    throw new Error("Usage: verify-rust-candidate.mjs --out-dir DIR --commit EXACT_SHA [--target TARGET] [--kind rust-release]");
  }
  const options = new Map();
  for (let index = 4; index < args.length; index += 2) {
    const flag = args[index];
    if (!["--target", "--kind"].includes(flag) || options.has(flag)) {
      throw new Error("Unsupported or duplicate candidate verification option");
    }
    options.set(flag, args[index + 1]);
  }
  if (options.has("--kind") && options.get("--kind") !== "rust-release") {
    throw new Error("Unsupported candidate kind");
  }
  const out = resolve(args[1]);
  const commit = args[3];
  // Cross-OS verification is needed by the trusted Linux publishing job.
  const target = options.get("--target") ?? process.platform + "-" + process.arch;
  const kind = options.get("--kind") ?? "unreleased-ci-candidate";
  if (!["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(target)) {
    throw new Error("Unsupported candidate platform");
  }
  const stem = "benchmark-rust-" + commit + "-" + target;
  const archiveName = stem + ".tar.gz";
  const metadataName = stem + ".json";
  const names = ["SHA256SUMS", archiveName, metadataName].sort();
  const actual = (await readdir(out)).sort();
  if (JSON.stringify(names) !== JSON.stringify(actual)) {
    throw new Error("Candidate directory must contain exactly the expected files");
  }
  const checksums = (await readFile(join(out, "SHA256SUMS"), "utf8")).trimEnd().split("\n");
  const observed = new Map();
  for (const line of checksums) {
    const m = /^([0-9a-f]{64})  ([0-9A-Za-z.-]+)$/.exec(line);
    if (!m || observed.has(m[2])) throw new Error("Malformed or duplicate checksum entry");
    observed.set(m[2], m[1]);
  }
  if (observed.size !== 2 || !observed.has(archiveName) || !observed.has(metadataName)) {
    throw new Error("Missing or unexpected checksums");
  }
  for (const name of [archiveName, metadataName]) {
    if (sha256(await readFile(join(out, name))) !== observed.get(name)) {
      throw new Error("SHA256 mismatch for " + name);
    }
  }
  const manifestBytes = await readFile(join(out, metadataName));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 ||
      manifest.kind !== kind ||
      manifest.commit !== commit || manifest.target !== target ||
      manifest.rustToolchain !== "1.85.1" ||
      !/^v\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("Candidate manifest source, target or schema mismatch");
  }
  const archive = join(out, archiveName);
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim().split("\n").map(x => x.replace(/\/$/, "")).sort();
  const expected = [
    "benchmark-rust",
    "benchmark-rust/README.md",
    "benchmark-rust/benchmark",
    "benchmark-rust/manifest.json"
  ].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error("Unexpected archive contents");
  }
  // Names alone are insufficient: a symlink can have the correct filename.
  // Check tar entry types and require an executable *regular file* for CLI.
  // GNU tar and BSD tar both start verbose entries with the 10 mode chars.
  const members = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" })
    .trim().split("\n");
  if (members.length !== expected.length) {
    throw new Error("Unexpected tar member count");
  }
  const archiveNames = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim().split("\n");
  for (let index = 0; index < archiveNames.length; index++) {
    const name = archiveNames[index].replace(/\/$/, "");
    const detailed = members[index];
    const mode = detailed.slice(0, 10);
    if (!detailed.endsWith(" " + archiveNames[index]) ||
        (name === "benchmark-rust" ? mode[0] !== "d" : mode[0] !== "-") ||
        (name === "benchmark-rust/benchmark" && !["x", "s"].includes(mode[3]))) {
      throw new Error("Invalid archive member type or executable permissions: " + name);
    }
  }
  const tarFile = path => execFileSync("tar", ["-xOf", archive, path], {
    maxBuffer: 100 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"]
  });
  if (!tarFile("benchmark-rust/manifest.json").equals(manifestBytes)) {
    throw new Error("Archive manifest differs from detached manifest");
  }
  const binary = tarFile("benchmark-rust/benchmark");
  const [platform, arch] = target.split("-");
  validateNativeBinary(binary, platform, arch);
  if (!manifest.binary || manifest.binary.name !== "benchmark" ||
      manifest.binary.bytes !== binary.length ||
      manifest.binary.sha256 !== sha256(binary)) {
    throw new Error("Binary bytes do not match manifest");
  }
  process.stdout.write("Verified unreleased Rust candidate " + stem + "\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
