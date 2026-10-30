#!/usr/bin/env node
// Read-only preparation gate. It verifies version alignment before a human
// creates a reviewed annotated release tag; it never creates tags or releases.
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function sections(content, heading) {
  const lines = content.split(/\r?\n/);
  const matches = [];
  let current = null;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      if (current !== null) matches.push(current);
      current = line.trim() === heading ? [] : null;
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) matches.push(current);
  return matches;
}

function field(section, key) {
  const matches = section.filter(line => new RegExp("^\\s*" + key + "\\s*=\\s*\"[^\"]+\"\\s*$").test(line));
  if (matches.length !== 1) throw new Error("Expected exactly one " + key + " in Cargo section");
  return matches[0].match(/=\s*"([^"]+)"/)[1];
}

export function validateReleaseVersions({ nodeManifest, cargoToml, cargoLock, expectedTag }) {
  const node = JSON.parse(nodeManifest);
  if (!validVersion.test(node.version) || node.version === "0.1.0") {
    throw new Error("Rust-ready repository must use a new stable version, not legacy 0.1.0");
  }
  if (expectedTag !== undefined && expectedTag !== "v" + node.version) {
    throw new Error("Requested release tag does not match Node package version");
  }
  const cargoSections = sections(cargoToml, "[package]");
  if (cargoSections.length !== 1 || field(cargoSections[0], "name") !== "benchmark-core" ||
      field(cargoSections[0], "version") !== node.version) {
    throw new Error("Cargo.toml package version must match package.json");
  }
  const rootPackages = sections(cargoLock, "[[package]]").filter(section =>
    field(section, "name") === "benchmark-core");
  if (rootPackages.length !== 1 || field(rootPackages[0], "version") !== node.version) {
    throw new Error("Cargo.lock root version must match package.json");
  }
  return "v" + node.version;
}

async function main() {
  const args = process.argv.slice(2);
  if (!(args.length === 0 ||
    (args.length === 2 && args[0] === "--version" &&
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(args[1])))) {
    throw new Error("Usage: check-rust-release-readiness.mjs [--version vX.Y.Z]");
  }
  const paths = ["package.json", "Cargo.toml", "Cargo.lock"];
  const [nodeManifest, cargoToml, cargoLock] = await Promise.all(paths.map(path =>
    readFile(join(root, path), "utf8")));
  const tag = validateReleaseVersions({
    nodeManifest, cargoToml, cargoLock, expectedTag: args[1]
  });
  process.stdout.write("Release metadata aligned for " + tag +
    " (read-only; no tag or GitHub Release created)\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
