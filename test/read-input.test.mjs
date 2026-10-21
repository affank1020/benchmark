import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedText } from "../src/read-input.mjs";

test("bounded reader accepts exact limits and rejects oversized input before decoding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "benchmark-"));
  const path = join(dir, "report.xml");
  try {
    await writeFile(path, "12345");
    assert.equal(await readBoundedText(path, 5), "12345");
    await assert.rejects(readBoundedText(path, 4), /File too large/);
    await assert.rejects(readBoundedText(path, 0), /File too large/);
    await assert.rejects(readBoundedText(path, -1), /Invalid byte limit/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
