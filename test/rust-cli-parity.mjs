// Compare the experimental Rust executable against the trusted Node CLI.
// This runs in the read-only Rust CI job, not the privileged publisher.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const node = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const rust = fileURLToPath(new URL("../target/debug/benchmark", import.meta.url));
const junit = fileURLToPath(new URL("./fixtures/node22-junit.xml", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "benchmark-rust-parity-"));
function file(name, text) {
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
}
function invoke(command, argv, json) {
  const result = spawnSync(command[0], [...command.slice(1), ...argv, "--json", json], {
    cwd: repo, encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, command[0] + ": " + result.stderr);
  return { markdown: result.stdout, json: JSON.parse(readFileSync(json, "utf8")) };
}
const cases = [];
try {
  const current = file("current.info", "SF:a\nLH:7\nLF:10\nFNH:0\nFNF:0\nBRH:1\nBRF:4\nend_of_record\n");
  const baseline = file("baseline.info", "SF:a\nLH:5\nLF:10\nFNH:0\nFNF:0\nBRH:0\nBRF:4\nend_of_record\n");
  const malformed = file("malformed.info", "SF:a\nLH:7\nLF:invalid\nend_of_record\n");
  const jest = file("jest.json", JSON.stringify({ numTotalTests: 8, numPassedTests: 5, numFailedTests: 1, numPendingTests: 1, numTodoTests: 1 }));
  const jestPlus = file("jest-plus.json", JSON.stringify({ numTotalTests: "+2", numPassedTests: "1", numTodoTests: "+1" }));
  const junitPlus = file("junit-plus.xml", '<testsuite tests="+1" failures="+0"><testcase/></testsuite>');
  const missing = join(directory, "nonexistent.info");
  const bomLcov = file("bom.info", "\ufeffLH:1\nLF:2\nend_of_record");
  const extreme = file("extreme.info", "LH:450359962737\nLF:9007199254740001\nend_of_record");

  cases.push(
    ["empty", []],
    ["ci-only", ["--ci", "cancelled"]],
    ["coverage-and-baseline", ["--coverage", current, "--baseline-coverage", baseline, "--ci", "success"]],
    ["junit-fixture", ["--tests", junit, "--ci", "failure"]],
    ["junit-plus", ["--tests", junitPlus]],
    ["jest-todos", ["--tests", jest, "--tests-format", "jest", "--ci", "success"]],
    ["jest-plus", ["--tests", jestPlus, "--tests-format", "jest"]],
    ["invalid-coverage", ["--coverage", malformed, "--baseline-coverage", baseline]],
    ["missing-current", ["--coverage", missing, "--baseline-coverage", baseline]],
    ["invalid-test", ["--tests", malformed, "--ci", "failure"]],
    ["bom-coverage", ["--coverage", bomLcov]],
    ["extreme-coverage", ["--coverage", extreme]],
    ["unknown-ci", ["--ci", "success | untrusted", "--coverage", current]],
    ["missing-baseline", ["--coverage", current, "--baseline-coverage", missing]]
  );

  for (const [label, args] of cases) {
    const baselineOutput = invoke([process.execPath, "--experimental-strip-types", node], args, join(directory, "node.json"));
    const rustOutput = invoke([rust], args, join(directory, "rust.json"));
    assert.deepEqual(rustOutput.json, baselineOutput.json, label + ": JSON mismatch");
    assert.equal(rustOutput.markdown, baselineOutput.markdown, label + ": Markdown mismatch");
    console.log("PASS parity " + label);
  }
  const nodeOut = join(directory, "node.md");
  const rustOut = join(directory, "rust.md");
  const baseFiles = invoke([process.execPath, "--experimental-strip-types", node], ["--coverage", current, "--output", nodeOut], join(directory, "node.json"));
  const rustFiles = invoke([rust], ["--coverage", current, "--output", rustOut], join(directory, "rust.json"));
  assert.equal(baseFiles.markdown, rustFiles.markdown);
  assert.equal(readFileSync(nodeOut, "utf8"), readFileSync(rustOut, "utf8"));
  assert.deepEqual(baseFiles.json, rustFiles.json);
  console.log("PASS parity output-to-file");

  for (const argv of [["--coverage"], ["oops"]]) {
    const a = spawnSync(process.execPath, ["--experimental-strip-types", node, ...argv], { encoding: "utf8", timeout: 15000 });
    const b = spawnSync(rust, argv, { encoding: "utf8", timeout: 15000 });
    assert.equal(a.status, 2);
    assert.equal(b.status, 2);
  }
  console.log("Rust CLI parity: " + cases.length + " fixtures, output-file fixture and invalid-argument fixtures.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
