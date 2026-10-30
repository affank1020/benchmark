import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateReleaseVersions } from "../scripts/check-rust-release-readiness.mjs";

const files = async () => {
  const [nodeManifest, cargoToml, cargoLock] = await Promise.all([
    "package.json", "Cargo.toml", "Cargo.lock"
  ].map(path => readFile(new URL("../" + path, import.meta.url), "utf8")));
  return { nodeManifest, cargoToml, cargoLock };
};

test("first Rust release metadata is exactly v0.2.0 in Node, Cargo and lock", async () => {
  const data = await files();
  assert.equal(validateReleaseVersions({ ...data, expectedTag: "v0.2.0" }), "v0.2.0");
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/check-rust-release-readiness.mjs", import.meta.url)),
    "--version", "v0.2.0"
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /read-only; no tag or GitHub Release created/);
});

test("version gate rejects Node/Cargo/Cargo.lock drift and legacy version", async () => {
  const inputs = await files();
  const scenarios = [
    { nodeManifest: inputs.nodeManifest.replace('"version": "0.2.0"', '"version": "0.1.0"') },
    { nodeManifest: inputs.nodeManifest.replace('"version": "0.2.0"', '"version": "0.3.0"') },
    { cargoToml: inputs.cargoToml.replace('version = "0.2.0"', 'version = "0.1.0"') },
    { cargoLock: inputs.cargoLock.replace(
      'name = "benchmark-core"\nversion = "0.2.0"',
      'name = "benchmark-core"\nversion = "0.3.0"') },
    { expectedTag: "v0.3.0" },
    { expectedTag: "v0.1.0" },
    { cargoToml: inputs.cargoToml + '\n[package]\nname = "benchmark-core"\nversion = "0.2.0"\n' },
    { cargoLock: inputs.cargoLock.replace(
      'name = "benchmark-core"\nversion = "0.2.0"',
      'name = "benchmark-core"\nversion = "0.2.0"\nversion = "0.2.0"') }
  ];
  for (const bad of scenarios) {
    assert.throws(() => validateReleaseVersions({ ...inputs, expectedTag: "v0.2.0", ...bad }),
      undefined, "Drift must fail: " + Object.keys(bad).join(", "));
  }
});

test("readiness command refuses invalid tag flags, and does not create release workflows", async () => {
  const script = fileURLToPath(new URL("../scripts/check-rust-release-readiness.mjs", import.meta.url));
  for (const args of [["--version", "main"], ["--version", "v0.1.0"],
    ["--version", "v0.2.1"], ["--version", "v0.2.0", "--tag", "main"], ["--publish"],
    ["--version", "v01.2.0"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "Bad command must be rejected: " + args.join(" "));
  }
  const [nodeFlow, rustFlow] = await Promise.all([
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/rust-release.yml", import.meta.url), "utf8")
  ]);
  assert.match(nodeFlow, /tags: \["v\*"\]/);
  assert.match(nodeFlow, /gh release create "\$TAG"/);
  assert.match(rustFlow, /workflow_dispatch:/);
  assert.doesNotMatch(rustFlow, /^\s*push:\s*$/m);
  assert.match(rustFlow, /gh release upload "\$TAG"/);
});
