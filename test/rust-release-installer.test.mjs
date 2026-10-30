import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installVerifiedRustRelease } from "../scripts/install-rust-release.mjs";

const commit = "a".repeat(40);
const version = "v0.2.0";
const target = process.platform + "-" + process.arch;
const stem = "benchmark-rust-" + commit + "-" + target;
const archiveName = stem + ".tar.gz";
const manifestName = stem + ".json";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const targets = ["linux-x64", "darwin-arm64", "darwin-x64"];

function image() {
  const b = Buffer.alloc(64);
  if (process.platform === "linux") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(b);
    b[4] = 2;
    b[5] = 1;
    b.writeUInt16LE(process.arch === "x64" ? 62 : 183, 18);
  } else {
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(b);
    b.writeUInt32LE(process.arch === "x64" ? 0x01000007 : 0x0100000c, 4);
  }
  return b;
}

async function fixture(fn) {
  const tmp = await mkdtemp(join(tmpdir(), "benchmark-consumer-test-"));
  const stage = join(tmp, "stage");
  const data = join(stage, "benchmark-rust");
  const assets = join(tmp, "assets");
  const destination = join(tmp, "install");
  try {
    await mkdir(data, { recursive: true });
    await mkdir(assets);
    const binary = image();
    const manifest = {
      schemaVersion: 1, kind: "rust-release", version, commit, target,
      rustToolchain: "1.85.1",
      binary: { name: "benchmark", bytes: binary.length, sha256: sha256(binary) }
    };
    await writeFile(join(data, "benchmark"), binary, { mode: 0o755 });
    await writeFile(join(data, "README.md"), "Offline release fixture\n");
    await writeFile(join(data, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const makeArchive = () => execFileSync("tar", ["-czf", join(assets, archiveName),
      "-C", stage, "benchmark-rust"]);
    const makeChecksums = async () => {
      const hash = name => sha256(execFileSync("cat", [join(assets, name)]));
      const rows = targets.flatMap(platform => {
        const name = "benchmark-rust-" + commit + "-" + platform;
        return [name + ".tar.gz", name + ".json"];
      }).sort().map(name => (
        (name === archiveName || name === manifestName ? hash(name) : "b".repeat(64)) +
        "  " + name
      )).join("\n") + "\n";
      await writeFile(join(assets, "rust-SHA256SUMS"), rows);
    };
    makeArchive();
    await writeFile(join(assets, manifestName), JSON.stringify(manifest, null, 2) + "\n");
    await makeChecksums();
    const install = (overrides = {}) => installVerifiedRustRelease({
      assetsDir: assets, destination, version, commit, ...overrides
    });
    await fn({ tmp, stage, data, assets, destination, binary, manifest, install,
      makeArchive, makeChecksums });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

test("offline Rust consumer installs only fully verified native assets and preserves a receipt", async () => {
  await fixture(async ({ install, destination, binary }) => {
    const receipt = await install();
    assert.equal(receipt.version, version);
    assert.equal(receipt.commit, commit);
    assert.equal(receipt.binarySha256, sha256(binary));
    assert.equal(receipt.source, "Caller-supplied offline assets; origin not authenticated");
    assert.doesNotMatch(receipt.source, /official GitHub Release/i,
      "A self-consistent synthetic archive does not prove GitHub origin");
    const output = await readFile(join(destination, "benchmark"));
    assert.ok(output.equals(binary));
    const info = await lstat(join(destination, "benchmark"));
    assert.ok(info.isFile());
    assert.ok(info.mode & 0o111, "Installed binary must remain executable");
    const json = JSON.parse(await readFile(join(destination, "installation.json"), "utf8"));
    assert.deepEqual(json, receipt);
    await assert.rejects(install(), /EEXIST/, "An existing install must never be replaced");
  });
});

test("consumer refuses wrong source identity, version and architecture before installation", async () => {
  await fixture(async ({ install, destination }) => {
    for (const override of [
      { version: "v0.1.0" }, { version: "v0.2.1" }, { version: "main" },
      { commit: "b".repeat(40) }, { commit: "bad" },
      { target: "win32-x64" },
      { target: process.platform === "linux" ? "darwin-arm64" : "linux-x64" }
    ]) await assert.rejects(install(override));
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  });
});

test("release installer rejects checksum, manifest, symlink and extra asset tampering", async () => {
  await fixture(async ({ install, assets, destination, makeChecksums, manifest }) => {
    await writeFile(join(assets, "rust-SHA256SUMS"), "garbage\n");
    await assert.rejects(install(), /Malformed or duplicate release checksum/);
    await makeChecksums();
    await writeFile(join(assets, manifestName),
      JSON.stringify({ ...manifest, version: "v9.9.9" }) + "\n");
    await assert.rejects(install(), /Official release checksum mismatch/);
    await makeChecksums();
    await assert.rejects(install(), /Official release manifest/);
    await writeFile(join(assets, manifestName), JSON.stringify(manifest, null, 2) + "\n");
    await makeChecksums();
    await writeFile(join(assets, "unexpected.txt"), "untrusted");
    await assert.rejects(install(), /Expected exactly/);
    await unlink(join(assets, "unexpected.txt"));
    await unlink(join(assets, manifestName));
    await symlink("rust-SHA256SUMS", join(assets, manifestName));
    await assert.rejects(install(), /non-regular/);
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  });
});

test("release installer rejects rehashed archive with unsafe tar member types/modes", async () => {
  await fixture(async ({ install, assets, data, destination, makeArchive, makeChecksums }) => {
    await chmod(join(data, "benchmark"), 0o644);
    makeArchive();
    await makeChecksums();
    await assert.rejects(install(), /Command failed|Invalid archive/);
    await chmod(join(data, "benchmark"), 0o755);
    await unlink(join(data, "README.md"));
    await symlink("manifest.json", join(data, "README.md"));
    makeArchive();
    await makeChecksums();
    await assert.rejects(install(), /Command failed|Invalid archive/);
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  });
});
