import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateNativeBinary } from "../scripts/package-rust-candidate.mjs";

function elf(arch) {
  const b = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(b);
  b[4] = 2;
  b[5] = 1;
  b.writeUInt16LE(arch === "x64" ? 62 : 183, 18);
  return b;
}
function mach(arch) {
  const b = Buffer.alloc(64);
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(b);
  b.writeUInt32LE(arch === "x64" ? 0x01000007 : 0x0100000c, 4);
  return b;
}

test("Rust candidate packaging refuses incorrect OS and architecture", () => {
  for (const [platform, arch, image] of [
    ["linux", "x64", elf("x64")],
    ["linux", "arm64", elf("arm64")],
    ["darwin", "x64", mach("x64")],
    ["darwin", "arm64", mach("arm64")]
  ]) {
    assert.doesNotThrow(() => validateNativeBinary(image, platform, arch));
    assert.throws(() => validateNativeBinary(image, platform, arch === "x64" ? "arm64" : "x64"));
    assert.throws(() => validateNativeBinary(image, platform === "linux" ? "darwin" : "linux", arch));
  }
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(32), Buffer.alloc(64), "not a binary"]) {
    assert.throws(() => validateNativeBinary(invalid, "linux", "x64"));
  }
  assert.throws(() => validateNativeBinary(elf("x64"), "win32", "x64"));
  assert.throws(() => validateNativeBinary(elf("x64"), "linux", "ia32"));
  const bigEndian = elf("x64");
  bigEndian[5] = 2;
  assert.throws(() => validateNativeBinary(bigEndian, "linux", "x64"));
});

test("candidate scripts require exact command-line arguments and never release", () => {
  const run = (script, args = []) => spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/" + script, import.meta.url)), ...args
  ], { encoding: "utf8" });
  for (const script of ["package-rust-candidate.mjs", "verify-rust-candidate.mjs"]) {
    const missing = run(script);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Usage:/);
    const invalid = run(script, ["--out-dir", "dist", "--commit", "main"]);
    assert.notEqual(invalid.status, 0);
  }
});

test("Rust candidate CI is read-only, native and separate from tagged privileged release", async () => {
  const candidate = await readFile(new URL("../.github/workflows/rust-binary-candidates.yml", import.meta.url), "utf8");
  const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(candidate, /permissions:\s*\n\s*contents: read/);
  assert.match(candidate, /pull_request:/);
  assert.match(candidate, /macos-15-intel/);
  assert.match(candidate, /macos-15/);
  assert.match(candidate, /ubuntu-24\.04/);
  assert.match(candidate, /cargo \+1\.85\.1 build --locked --release --bin benchmark/);
  assert.match(candidate, /node scripts\/package-rust-candidate\.mjs/);
  assert.match(candidate, /node scripts\/verify-rust-candidate\.mjs/);
  assert.match(candidate, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(candidate, /gh release |contents: write|pull_request_target|workflow_run|workflow_dispatch|tag:/);
  assert.match(release, /Verify existing annotated tag/);
  assert.match(release, /gh release create/);
  assert.doesNotMatch(release, /package-rust-candidate|verify-rust-candidate/);
});
