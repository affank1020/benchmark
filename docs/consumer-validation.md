# External consumer & fork validation

Benchmark's reusable reporter runs in the **consumer repository's trusted default-branch** workflow after a separate, read-only PR CI workflow uploads test and coverage artifacts. The reporter does **not** execute PR code; only the trusted post-CI workflow gets permission to write comments.

## Consumer setup

1. Choose a **separate** test repository under your control with CI triggered by both `push` on `main` and `pull_request`. Avoid changing a production repo's privileged workflows without reviewing the proposed integration.
2. Adapt the existing test execution to emit **both** `junit.xml` and `lcov.info` at the root of a `benchmark-ci` artifact; use `if: always()` to upload available inputs after failures. Benchmark does not rerun tests itself.
3. Copy [`examples/use-reusable-report.yml`](../examples/use-reusable-report.yml) into `.github/workflows/benchmark-report.yml` in the consumer. The reusable workflow reference is pinned to reviewed Benchmark PR #6 merge (`bb128d710834af8f763eb116bfd768af9d326d9b`). Set the `workflows:` filter to the exact existing CI workflow name; update `artifact_name` if required.
4. Review the trusted caller's `contents: read`, `actions: read`, `issues: write` and `pull-requests: write` permissions. If organization settings disallow the reusable workflow, explicitly authorize the reviewed SHA instead of relaxing branch protections.
5. Merge the consumer setup only after its own independent review. GitHub only enables `workflow_run` triggers present on the consumer's **default branch**, not an unmerged feature branch.
6. Verify that the consumer's exact current `main` SHA has a **successful push CI** with a single nonexpired `benchmark-ci` artifact containing `lcov.info`. A PR targeting an older baseline legitimately has no delta.

## Consumer acceptance checks

The optional early-comment workflow listens to the existing read-only CI workflow's `workflow_run` `requested` and `in_progress` events, using reviewed, pinned default-branch code. Waiting appears when CI starts, not necessarily at PR creation; `pull_request_target` is not used. The existing completed-workflow reporter remains the final authority.


On a new PR against that instrumented `main`, verify:

- Read-only PR CI uploads the expected JUnit + LCOV artifact using the existing test execution, on success and where possible on failure.
- A separate trusted `workflow_run` succeeds, selects only the current PR and the **exact** current base SHA's successful push CI artifact, and writes one Benchmark report comment.
- The report shows **current**, **baseline**, and signed **percentage-point change** columns. Metrics missing in either input appear unavailable, not zero.
- A subsequent commit updates the same report comment, rather than posting duplicates.
- A failing CI run is reported as failed; stale heads, changed bases, reruns and ambiguous source PRs do not publish out-of-date comparisons.

## Fork acceptance checks (separate live drill)

Open a PR from a **separate fork** of the consumer repository and validate:

- Fork PR CI runs with a read-only token and uploads its artifact to the consumer's Actions.
- The publisher associates `workflow_run` to exactly one open PR by **source repository ID, branch and SHA**, even if GitHub omits `workflow_run.pull_requests`.
- Stale or ambiguous mappings, closed PRs and retargeted branches cannot cause a privileged report on the wrong PR.
- The reporter never checks out or executes untrusted fork code with a write token, uses `pull_request_target` or passes secrets to PR code.

If a fork-run approval or repository policy blocks execution, record the case as **not verified**, rather than claiming a live success based on mocks.

## Verified producer evidence and remaining limits

The first `main` CI after Benchmark PR #6 merged is [run 39766014438](https://github.com/affank1020/benchmark/actions/runs/39766014438) at SHA `bb128d710834af8f763eb116bfd768af9d326d9b`. Its artifact `benchmark-ci` (ID `12419718645`) contains both `junit.xml` and `lcov.info`. This proves the producer path; it does **not** by itself establish cross-repository or fork end-to-end compatibility.

The automated test in `test/automatic-baseline.test.mjs` executes the **actual reusable workflow's** base-lookup script using a different consumer repository, a fork-originated source identity and a custom artifact name. Those GitHub API responses are mocked, so passing tests are not equivalent to a live external consumer or fork drill.

After completing each live drill, record the consumer CI run, publisher run, PR comment URL, source/base SHAs and any blockers here. Do not claim full production validation until the above matrix is exercised.
