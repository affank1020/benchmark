# External consumer & fork validation

Benchmark's reusable reporter runs in the **consumer repository's trusted default-branch** workflow after a separate, read-only PR CI workflow uploads test and coverage artifacts. The reporter does **not** execute PR code; only the trusted post-CI workflow gets permission to write comments.

## Consumer setup

1. Choose a **separate** test repository under your control with CI triggered by both `push` on `main` and `pull_request`. Avoid changing a production repo's privileged workflows without reviewing the proposed integration.
2. Adapt the existing test execution to emit **both** `junit.xml` and `lcov.info` at the root of a `benchmark-ci` artifact; use `if: always()` to upload available inputs after failures. Benchmark does not rerun tests itself.
3. Copy [`examples/use-reusable-report.yml`](../examples/use-reusable-report.yml) into `.github/workflows/benchmark-report.yml` in the consumer. The example reusable workflow reference is pinned to reviewed Benchmark PR #9 merge (`eb53a1881039fcd53ecce821f327bd0b6990acb8`). Set the `workflows:` filter to the exact existing CI workflow name; update `artifact_name` if required.
4. Review the trusted caller's `contents: read`, `actions: read`, `issues: write` and `pull-requests: write` permissions. If organization settings disallow the reusable workflow, explicitly authorize the reviewed SHA instead of relaxing branch protections.
5. Merge the consumer setup only after its own independent review. GitHub only enables `workflow_run` triggers present on the consumer's **default branch**, not an unmerged feature branch.
6. Verify that the consumer's exact current `main` SHA has a **successful push CI** with a single nonexpired `benchmark-ci` artifact containing `lcov.info`. A PR targeting an older baseline legitimately has no delta.

## Released consumer workflows

After a reviewed Benchmark release, download `benchmark-report.yml` and `benchmark-lifecycle.yml` from that release and inspect their **40-character source and trusted matcher SHAs**. Each release also provides a SHA256 manifest for checking downloaded assets. Match the `workflows: [CI]` name to the consumer's existing read-only CI workflow, and keep the publishing workflows on its default branch. The release does not deploy anything automatically to consumers; see [release procedure](releasing.md).

## Rust binary consumer validation (separate from the GitHub API publisher)

The **native Rust CLI** can be downloaded and installed offline using [`scripts/install-rust-release.mjs`](../scripts/install-rust-release.mjs) and the exact version/tag/commit recipe in [Rust release promotion](rust-release-promotion.md). The installer validates released asset bytes and target architecture before writing into a **new** installation directory; it does **not** alter the consumer's GitHub Actions workflow, grant comment permissions, execute the downloaded program or trigger an automatic upgrade.

The read-only CI matrix executes the installer's local positive and negative fixtures on Linux x64, macOS arm64 and macOS Intel. **These use simulated release inputs**, rather than a real downloaded GitHub Release, and are not a substitute for a live external consumer drill.

After a real reviewed Rust release exists, record the exact source SHA, tag, downloaded `rust-SHA256SUMS`, native binary hash, installation receipt and run result from a **separate disposable consumer repository**. Also verify switching the consumer back to its existing immutable Node/v0.1.0 pin. Do not upgrade Atlas as a side effect of testing the installer. The `workflow_run` publisher's checked-out Rust source is pinned independently and has its own review/deployment process.

## Multi-job CI inputs

The reusable reporter accepts `tests_artifact_name` and `coverage_artifact_name` from independent jobs in the same CI workflow run. Each exact-name artifact is validated and downloaded by ID to an isolated directory; duplicate, oversized or expired artifacts cannot be silently substituted. The baseline comparison uses the coverage artifact name from the exact base-branch push CI run. The default combined `benchmark-ci` format is still supported.

## Consumer acceptance checks

The optional early-comment workflow listens to the existing read-only CI workflow's `workflow_run` `requested` and `in_progress` events, using reviewed, pinned default-branch code. Waiting appears when CI starts, not necessarily at PR creation; `pull_request_target` is not used. The existing completed-workflow reporter remains the final authority. Ensure the lifecycle and completed reporter (including reusable variants) use the **same concurrency group**, with `queue: max` and `cancel-in-progress: false`, so a late CI-start event cannot evict a pending completed result. GitHub caps queued runs at 100 per group.


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
