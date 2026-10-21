// Pure safety policy shared by the trusted GitHub Actions reporter and tests.
export function matchesRunToPr(run, pr) {
  return Boolean(
    pr?.state === "open" &&
    typeof run?.head_sha === "string" &&
    run.head_sha.length > 0 &&
    Number.isSafeInteger(run.head_repository?.id) &&
    pr.head?.repo?.id === run.head_repository.id &&
    typeof run.head_branch === "string" &&
    pr.head?.ref === run.head_branch &&
    (pr.head.sha === run.head_sha || pr.merge_commit_sha === run.head_sha)
  );
}

// workflow_run.pull_requests can be empty for PRs originating from forks.
// Commit association in the base repository can also miss fork-only commits.
// Use the source repository/branch to discover candidates, but never trust
// that discovery without checking the fetched PR's identity and exact SHA.
export async function resolveRunPr(run, github, { owner, repo }) {
  if (run?.event !== "pull_request" ||
      !Number.isSafeInteger(run.head_repository?.id) ||
      !run.head_repository?.owner?.login ||
      typeof run.head_branch !== "string" || !run.head_branch ||
      typeof run.head_sha !== "string" || !run.head_sha) {
    return null;
  }

  async function validated(candidates, exactHeadOnly) {
    const numbers = [...new Set(candidates.map(candidate => candidate.number))]
      .filter(number => Number.isSafeInteger(number) && number > 0);
    const matches = [];
    for (const number of numbers) {
      const { data: pr } = await github.rest.pulls.get({
        owner, repo, pull_number: number
      });
      if (pr.base?.repo?.full_name !== `${owner}/${repo}`) continue;
      if (!matchesRunToPr(run, pr)) continue;
      if (exactHeadOnly && pr.head.sha !== run.head_sha) continue;
      matches.push(pr);
    }
    // Ambiguous associations must not cause a report on an arbitrary PR.
    return matches.length === 1 ? matches[0] : null;
  }

  const eventPrs = run.pull_requests ?? [];
  if (eventPrs.length) {
    const pr = await validated(eventPrs, false);
    if (pr) return pr;
  }

  let associated = [];
  try {
    associated = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
      owner, repo, commit_sha: run.head_sha, per_page: 100
    });
  } catch {
    // A fork-only SHA need not be resolvable by the base repo's commit API.
    // Fallback candidates are checked using the full source identity below.
  }
  if (associated.length) {
    const pr = await validated(associated, false);
    if (pr) return pr;
  }

  const head = `${run.head_repository.owner.login}:${run.head_branch}`;
  const forkCandidates = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: "open", head, per_page: 100
  });
  return validated(forkCandidates, true);
}

export function isLatestCompletedRun(run, candidates) {
  if (!Number.isSafeInteger(run?.id) || !Number.isSafeInteger(run?.run_number) ||
      !Number.isSafeInteger(run?.run_attempt) || !Number.isSafeInteger(run?.workflow_id) ||
      !Array.isArray(candidates)) return false;
  const matching = candidates.filter(candidate =>
    candidate.workflow_id === run.workflow_id &&
    candidate.head_sha === run.head_sha &&
    candidate.event === "pull_request" &&
    candidate.status === "completed"
  );
  // Fail closed if the source run is not returned by GitHub.
  if (!matching.some(candidate =>
    candidate.id === run.id && candidate.run_attempt === run.run_attempt
  )) return false;
  return !matching.some(candidate =>
    candidate.run_number > run.run_number ||
    (candidate.run_number === run.run_number && candidate.run_attempt > run.run_attempt)
  );
}

export function findOwnedReportComment(comments, marker) {
  return comments.find(comment =>
    comment.user?.login === "github-actions[bot]" &&
    typeof comment.body === "string" &&
    comment.body.includes(marker)
  );
}
