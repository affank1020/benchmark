import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matchesRunToPr, isLatestCompletedRun, findOwnedReportComment } from "../src/publish-policy.mjs";

const run = {
  id: 101, run_number: 10, run_attempt: 1, workflow_id: 33,
  head_sha: "abc", event: "pull_request", status: "completed"
};
test("PR head changed during artifact download => cannot publish", () => {
  assert.equal(matchesRunToPr(run, { state: "open", head: { sha: "def" }, merge_commit_sha: "xyz" }), false);
  assert.equal(matchesRunToPr(run, { state: "open", head: { sha: "abc" } }), true);
  assert.equal(matchesRunToPr(run, { state: "closed", head: { sha: "abc" } }), false);
});
test("older completed CI cannot overwrite newer run on same head", () => {
  const newer = { ...run, id: 102, run_number: 11 };
  assert.equal(isLatestCompletedRun(run, [run, newer]), false);
  assert.equal(isLatestCompletedRun(newer, [run, newer]), true);
});
test("reruns on the same run ID supersede prior attempts", () => {
  const second = { ...run, run_attempt: 2 };
  assert.equal(isLatestCompletedRun(run, [second]), false);
  assert.equal(isLatestCompletedRun(second, [second]), true);
});
test("run presence/identity must be verified, unrelated CI ignored", () => {
  assert.equal(isLatestCompletedRun(run, []), false);
  assert.equal(isLatestCompletedRun(run, [run, { ...run, id: 103, run_number: 99, head_sha: "other" }]), true);
});
test("only the GitHub Actions bot's marked comment may be updated", () => {
  const marker = "<!-- benchmark-pr-quality-report -->";
  const comments = [
    { id: 1, user: { login: "other[bot]" }, body: marker },
    { id: 2, user: { login: "github-actions[bot]" }, body: marker },
  ];
  assert.equal(findOwnedReportComment(comments, marker)?.id, 2);
});
test("workflow explicitly serializes publishers for the same PR source", async () => {
  const workflow = await readFile(new URL("../examples/report-pr.yml", import.meta.url), "utf8");
  assert.match(workflow, /concurrency:\s*\n\s*group: benchmark-report-/);
  assert.match(workflow, /cancel-in-progress: false/);
});
