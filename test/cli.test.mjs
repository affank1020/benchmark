import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("CLI consumes flat Node.js 22 JUnit-format artifact end to end", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/node22-junit.xml", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "benchmark-junit-cli-"));
  try {
    const jsonPath = join(directory, "benchmark.json");
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types", cli, "--tests", fixture, "--ci", "failure",
      "--json", jsonPath
    ], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.deepEqual(report.tests, { total: 3, passed: 1, failed: 1, skipped: 1 });
    assert.equal(report.ci, "failure");
    assert.match(result.stdout, /1 passed · 1 failed · 1 skipped \/ 3 total/);
    assert.doesNotMatch(result.stdout, /Test artifact missing or invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
