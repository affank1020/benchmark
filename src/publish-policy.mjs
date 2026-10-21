// Pure safety policy shared by the trusted GitHub Actions reporter and tests.
export function matchesRunToPr(run, pr) {
  return Boolean(
    pr?.state === "open" &&
    run?.head_sha &&
    (pr.head?.sha === run.head_sha || pr.merge_commit_sha === run.head_sha)
  );
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
