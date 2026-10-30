import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
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


test("verifier rejects a rehashed archive with a symlink or non-executable CLI", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "benchmark-tar-types-"));
  try {
    const stage = join(tmp, "stage");
    const dir = join(stage, "benchmark-rust");
    const out = join(tmp, "out");
    await mkdir(dir, { recursive: true });
    await mkdir(out);
    const sha = "a".repeat(40);
    const target = process.platform + "-" + process.arch;
    const binary = process.platform === "darwin" ? mach(process.arch) : elf(process.arch);
    const manifest = JSON.stringify({
      schemaVersion: 1, kind: "unreleased-ci-candidate", version: "v0.1.0",
      commit: sha, target, rustToolchain: "1.85.1",
      binary: { name: "benchmark", bytes: binary.length,
        sha256: createHash("sha256").update(binary).digest("hex") }
    }, null, 2) + "\n";
    await writeFile(join(dir, "benchmark"), binary, { mode: 0o755 });
    await writeFile(join(dir, "README.md"), "candidate\n");
    await writeFile(join(dir, "manifest.json"), manifest);
    const stem = "benchmark-rust-" + sha + "-" + target;
    const archive = stem + ".tar.gz";
    const meta = stem + ".json";
    await writeFile(join(out, meta), manifest);
    const repack = async () => {
      execFileSync("tar", ["-czf", join(out, archive), "-C", stage, "benchmark-rust"]);
      const digest = name => createHash("sha256").update(execFileSync("cat", [join(out, name)])).digest("hex");
      await writeFile(join(out, "SHA256SUMS"),
        [archive, meta].sort().map(name => digest(name) + "  " + name).join("\n") + "\n");
    };
    const verify = () => spawnSync(process.execPath, [
      fileURLToPath(new URL("../scripts/verify-rust-candidate.mjs", import.meta.url)),
      "--out-dir", out, "--commit", sha
    ], { encoding: "utf8" });

    await repack();
    assert.equal(verify().status, 0, "Valid control archive should verify");
    await unlink(join(dir, "README.md"));
    await symlink("manifest.json", join(dir, "README.md"));
    await repack();
    assert.match(verify().stderr, /Invalid archive member type/, "Rehashed symlink must fail");
    await unlink(join(dir, "README.md"));
    await writeFile(join(dir, "README.md"), "candidate\n");
    await chmod(join(dir, "benchmark"), 0o644);
    await repack();
    assert.match(verify().stderr, /Invalid archive member type or executable permissions/,
      "Rehashed non-executable binary must fail");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("native packager always makes a fresh isolated Cargo build before archive", async () => {
  const code = await readFile(new URL("../scripts/package-rust-candidate.mjs", import.meta.url), "utf8");
  assert.match(code, /mkdtemp\(join\(tmpdir\(\), "benchmark-rust-source-build-"\)\)/);
  assert.match(code, /"build", "--locked", "--release", "--bin", "benchmark"/);
  assert.match(code, /"--target-dir", build/);
  assert.doesNotMatch(code, /join\(root, "target", "release", "benchmark"\)/);
});
