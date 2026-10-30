# Rust reporter in the trusted Benchmark publisher

**Scope:** [Rust workflow integration #16](https://github.com/affank1020/benchmark/issues/16). This is a change to the report **renderer**, not to the GitHub API policy, CI producer or consumer installation.

## Two separate, immutable checkouts

The trusted `workflow_run` publisher contains:

1. `benchmark/` from policy commit `81b6602198c38a74d6b539a484ff25b86c8e0cc8`. `src/publish-policy.mjs` still verifies source PR identity and SHA, current CI run/attempt, latest completed CI, exact base SHA/branch, and bot-owned comment lifecycle. The Node runtime remains for the reviewed `actions/github-script` policy.
2. `benchmark-rust/` from **Rust CLI source commit** `ed03341fd34abf651a859a8dc8780ca596484856` (merged after reviewed #20). Only this checkout is compiled to render a Markdown report. Both checkouts are immutable, use `persist-credentials: false`, and never use `github.event.workflow_run.head_sha` or a PR branch as executable source.

The publisher installs Rust **1.85.1** on its fresh Linux runner and uses:

```bash
cargo +1.85.1 build --locked --release --manifest-path benchmark-rust/Cargo.toml --bin benchmark
```

The output `benchmark-rust/target/release/benchmark` receives the same `--coverage`, `--tests`, `--ci`, optional `--baseline-coverage` and `--output benchmark-report.md` inputs as the legacy Node CLI.

## Unchanged security controls

- Trigger remains a default-branch `workflow_run` of the read-only CI workflow, not `pull_request_target`. Reporting checks `workflow_run.event == 'pull_request'`.
- GitHub access remains in the existing `github-script` steps using the older policy commit: verified PR resolution including forks; exact head and base SHA validation; current run ID, run attempt, and latest completed run; bounded artifacts selected by verified unique name and exact ID; and a single bot-owned comment marker with Waiting → Processing → Ready/Error/Unavailable semantics.
- Artifact archive retrieval and extraction stay in separate `artifacts/tests`, `artifacts/coverage`, and `baseline` directories. The Rust process **reads these files as bounded data**; it does not execute them. Malformed/missing reports stay unavailable rather than becoming false passes.
- Concurrency group, `queue: max`, `cancel-in-progress: false`, and last-moment freshness guards are unchanged.
- The published `v0.1.0` bundle and existing consumer reusable-workflow pins are unchanged. This commit is **not a release** and does not upgrade consumers.

Only `.github/workflows/benchmark-report.yml`, `.github/workflows/reusable-report.yml`, and `examples/report-pr.yml` switch renderer invocation. `.github/workflows/benchmark-lifecycle.yml` and `examples/lifecycle-pr.yml` still use the old reviewed Node policy; that early workflow does not render coverage.

## Validation before merge

`node --test test/*.test.mjs` includes publisher invariants, lifecycle, fork/SHA validation, stale-run and rerun rejection, missing/duplicate/oversized artifact cases, and the new Rust-step pin/order/permission contracts.

The Rust CI job runs formatting, Clippy, tests, Node↔Rust output differential fixtures and a **locked release build**. Its release smoke check compares the Rust renderer's output (missing coverage, valid JUnit, failed CI) with the Node renderer byte-for-byte.

**Limitations:** PR CI cannot execute a new `workflow_run` workflow on the default branch. Even green tests do not prove the new publisher can publish a live comment. A real `workflow_run` event occurs only after merge; a post-merge self-dogfood run and independent security review are required.

## Post-merge self-dogfood and rollback

After independent review and merge:

1. Open a small, ordinary PR to Benchmark with the established read-only `CI` workflow. Confirm the lifecycle uses **one** marked comment and reports Waiting → Processing → Ready, including baseline if the exact base SHA has a successful push artifact.
2. Exercise one CI rerun and one missing/invalid-artifact case; verify the publisher does not overwrite newer results and reports unavailable metrics on the existing comment. Observe both the reporter's Actions logs and the PR comment.
3. Confirm existing external consumers (including Atlas) remain on their previous reviewed SHA pins. Upgrade only through a separately reviewed consumer change.
4. On an integration regression, revert the commit that switched the three publisher workflow files, restoring `node --experimental-strip-types benchmark/src/cli.mjs` while keeping the old pinned policy. Do not point a privileged job to a mutable branch, downgrade artifact or freshness checks, or retag/rewrite `v0.1.0`. Rerun the affected CI after the rollback reaches the default branch.

The next roadmap issue [#17](https://github.com/affank1020/benchmark/issues/17) covers reproducible binary releases and consumer validation rather than modifying these trusted GitHub API policy scripts.
