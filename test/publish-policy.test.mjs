import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matchesRunToPr, resolveRunPr, isLatestCompletedRun, findOwnedReportComment } from "../src/publish-policy.mjs";

const run = {
  id: 101, run_number: 10, run_attempt: 1, workflow_id: 33,
  head_sha: "abc", head_branch: "fix", head_repository: {
    id: 200, owner: { login: "contributor" }
  }, event: "pull_request", status: "completed"
};
const pr = {
  number: 17, state: "open", head: {
    sha: "abc", ref: "fix", repo: { id: 200 }
  }, base: { repo: { full_name: "affank1020/benchmark" } },
  merge_commit_sha: "merge-sha"
};
function fakeGitHub({ associated = [], list = [], pullRequests = [pr], failAssociation = false } = {}) {
  const calls = { associated: 0, list: 0, get: [], head: null };
  const github = {
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: async () => {
          calls.associated++;
          if (failAssociation) throw new Error("fork commit unavailable");
          return associated;
        }
      },
      pulls: {
        list: async ({ head }) => {
          calls.list++;
          calls.head = head;
          return list;
        },
        get: async ({ pull_number }) => {
          calls.get.push(pull_number);
          const match = pullRequests.find(item => item.number === pull_number);
          if (!match) throw new Error("PR not found");
          return { data: match };
        }
      }
    },
    paginate: (fn, options) => fn(options)
  };
  return { github, calls };
}
test("PR head or source identity changes => cannot publish", () => {
  assert.equal(matchesRunToPr(run, { ...pr, head: { ...pr.head, sha: "def" } }), false);
  assert.equal(matchesRunToPr(run, pr), true);
  assert.equal(matchesRunToPr(run, { ...pr, state: "closed" }), false);
  assert.equal(matchesRunToPr(run, { ...pr, head: { ...pr.head, repo: { id: 999 } } }), false);
  assert.equal(matchesRunToPr(run, { ...pr, head: { ...pr.head, ref: "another" } }), false);
});
test("fork-only CI commit resolves using source owner/branch with exact repo and SHA", async () => {
  const { github, calls } = fakeGitHub({
    associated: [], list: [{ number: 17 }]
  });
  const resolved = await resolveRunPr(
    { ...run, pull_requests: [] }, github, { owner: "affank1020", repo: "benchmark" }
  );
  assert.equal(resolved?.number, 17);
  assert.equal(calls.associated, 1);
  assert.equal(calls.list, 1);
  assert.equal(calls.head, "contributor:fix");
});
test("fork-only CI commit lookup errors also use safe source fallback", async () => {
  const { github } = fakeGitHub({ failAssociation: true, list: [{ number: 17 }] });
  assert.equal((await resolveRunPr(
    { ...run, pull_requests: [] }, github, { owner: "affank1020", repo: "benchmark" }
  ))?.number, 17);
});
test("event-associated PR resolves without fetching branch candidates", async () => {
  const { github, calls } = fakeGitHub();
  const resolved = await resolveRunPr(
    { ...run, pull_requests: [{ number: 17 }] }, github,
    { owner: "affank1020", repo: "benchmark" }
  );
  assert.equal(resolved?.number, 17);
  assert.equal(calls.associated, 0);
  assert.equal(calls.list, 0);
});
test("fork branch collisions cannot publish to another repository or stale SHA", async () => {
  for (const altered of [
    { ...pr, head: { ...pr.head, repo: { id: 201 } } },
    { ...pr, head: { ...pr.head, sha: "other" } },
    { ...pr, head: { ...pr.head, ref: "another" } },
    { ...pr, state: "closed" },
    { ...pr, base: { repo: { full_name: "affank1020/not-benchmark" } } },
    { ...pr, head: { ...pr.head, sha: "wrong" }, merge_commit_sha: "abc" }
  ]) {
    const { github } = fakeGitHub({ list: [{ number: 17 }], pullRequests: [altered] });
    const resolved = await resolveRunPr(
      { ...run, pull_requests: [] }, github, { owner: "affank1020", repo: "benchmark" }
    );
    assert.equal(resolved, null);
  }
});
test("ambiguous fork matches fail closed rather than publish arbitrarily", async () => {
  const second = { ...pr, number: 18 };
  const { github } = fakeGitHub({
    list: [{ number: 17 }, { number: 18 }], pullRequests: [pr, second]
  });
  assert.equal(await resolveRunPr(
    { ...run, pull_requests: [] }, github, { owner: "affank1020", repo: "benchmark" }
  ), null);
});
test("missing source identity fails closed without querying GitHub", async () => {
  const { github, calls } = fakeGitHub({ list: [{ number: 17 }] });
  assert.equal(await resolveRunPr(
    { ...run, head_repository: undefined }, github, { owner: "affank1020", repo: "benchmark" }
  ), null);
  assert.equal(calls.list, 0);
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
