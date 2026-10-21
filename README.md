# Benchmark — PR Quality Report

**Benchmark** is an open-source tool that turns existing GitHub Actions results into an automatically updated pull-request quality report. It deliberately **does not rerun your tests**.

## First milestone

The current MVP provides:
- LCOV line, function and branch coverage parsing.
- JUnit XML and Jest JSON test-summary parsing (Jest TODO cases count as skipped, not passed).
- CI conclusion reporting, including failed, cancelled and timed-out runs.
- Deterministic Markdown output, JSON output and explicit unavailable metrics.
- A trusted `workflow_run` integration example that updates a single bot comment.

The report is informational; it does not gate merges or imply that missing coverage is zero.

## Run locally (Node.js 22+)

```bash
node --experimental-strip-types src/cli.mjs \
  --coverage ./coverage/lcov.info \
  --tests ./test-results/junit.xml \
  --ci failure \
  --output benchmark.md \
  --json benchmark.json
```

For Jest JSON summaries, add `--tests-format jest`. Paths may be omitted. Missing or unparseable files are reported as unavailable rather than falsely passing. Exit code zero means a report was rendered; it **does not indicate CI passed**.

```bash
npm test
```

No runtime or test dependencies.

## GitHub Actions integration

1. In your existing PR-triggered **CI** workflow, upload the coverage and test files as one artifact named `benchmark-ci`, containing `lcov.info` and `junit.xml` at its root. Use `if: always()` so the artifact is uploaded even when the test job fails. If no results exist, Benchmark will show those metrics as unavailable.
2. Copy [`examples/report-pr.yml`](examples/report-pr.yml) to `.github/workflows/benchmark-report.yml` in the consuming repository. Change `workflows: [CI]` to match your CI workflow's exact name. Replace the `affank1020/benchmark` checkout ref with a pinned released commit once available.
3. The reporter runs **after** CI completes, so it can report failed workflows. It checks out trusted Benchmark code, never executes PR code with a write token, and uses `issues: write` and `pull-requests: write` to create or update one comment. Its PR resolution is SHA-checked; if it cannot confidently associate a run with the current PR head, it skips posting.

Minimal artifact upload in an existing CI workflow:

```yaml
- name: Upload Benchmark inputs
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: benchmark-ci
    path: |
      coverage/lcov.info
      test-results/junit.xml
    if-no-files-found: ignore
```

To have the two files appear at artifact root, stage them there in CI or adapt the paths in `examples/report-pr.yml`.

## Reusable workflow integration (preview)

For another repository, use the short [reusable reporter caller](examples/use-reusable-report.yml) rather than copying the full [publisher](examples/report-pr.yml). The consumer keeps a trusted `workflow_run` trigger on its default branch and grants `contents: read`, `actions: read`, `issues: write` and `pull-requests: write`. Configure `workflows: [CI]` to match the name of its existing pull-request CI workflow.

The caller needs only:

```yaml
jobs:
  report:
    if: github.event.workflow_run.event == 'pull_request'
    uses: affank1020/benchmark/.github/workflows/reusable-report.yml@REPLACE_WITH_REVIEWED_40_CHAR_RELEASE_SHA
    with:
      artifact_name: benchmark-ci
```

**The placeholder must be replaced by an immutable reviewed 40-character commit SHA before the example can run.** Never deploy the privileged caller using `@main` or another moving ref. The reusable workflow independently checks out Benchmark's reviewed PR #2 merge (`c4aa9c6a76d71e57809954cbc17627dcb250ab56`) as its trusted reporter implementation. Advancing that pinned implementation is a deliberate compatibility/security change.

The consumer's own CI must upload an artifact named `benchmark-ci` (or the chosen `artifact_name`) containing `lcov.info` and `junit.xml` at its root. It should upload on failure (`if: always()`); missing inputs are represented as unavailable, never fabricated. The reusable workflow runs in the **consumer repository's** security context, not on PR-supplied code. No external installation or personal access token is required when the repository and workflow permissions allow reusable calls.

**Publication currently blocked pending end-to-end authorization verification.** The installed reporter on `main` processed PR #3's CI successfully but GitHub returned HTTP 403 when creating the PR comment ([failed publisher run](https://github.com/affank1020/benchmark/actions/runs/39680413383)), even though the job displayed `Issues: write`. A documented GitHub App permissions issue suggests also granting `pull-requests: write`; this PR grants it to the installed, example and reusable workflows. This change cannot be validated by the default-branch `workflow_run` publisher until it is merged. Do not treat the reusable integration as production-ready until a real comment is successfully created/updated and a separate consumer/fork has been tested.

## Benchmark reporting on Benchmark

This repository installs its own [trusted reporting workflow](.github/workflows/benchmark-report.yml), matching the public [integration example](examples/report-pr.yml). Once the workflow is on the **default branch** and GitHub authorizes the write token, completed PR CI runs should produce a single updatable Benchmark comment on their own pull requests. The underlying CI keeps publishing `benchmark-ci` artifacts even when tests fail, so failed runs can still be reported. Coverage remains **Not reported** until CI generates `lcov.info`.

Fork-originated `workflow_run` events may omit pull-request associations, and GitHub's commit lookup can miss fork-only SHAs. The publisher therefore also discovers open PRs by source repository owner and branch, and only accepts one with matching repository ID, branch, and commit SHA. Ambiguous or stale matches are skipped rather than posting to the wrong PR. This fallback is covered by mocked GitHub API regression tests; a live fork PR still needs verification after deployment.

The reporting workflow uses `workflow_run`, which GitHub only activates from the default branch. A change to the reporter workflow in a PR cannot validate its own publishing behaviour until merged; subsequent PRs exercise the end-to-end path. `test/workflow-contract.test.mjs` guards drift between the installed workflow and the example. For new repositories, follow the integration instructions below instead of copying the Benchmark-specific workflow without review.

## Security model

The reporter uses the trusted default-branch workflow via `workflow_run`. Untrusted artifacts are read **only as bounded text/metrics**, never executed. The publisher serializes report jobs per PR source and checks the run's current attempt, newest completed workflow run, and PR head SHA immediately before posting to avoid duplicate or stale reports. The parser also enforces a 10 MiB per-file read limit and the sample workflow checks compressed artifact size (25 MiB) before downloading. Do not replace the reporter's checkout with a checkout of the untrusted PR. Keep the reporting workflow on the default branch.

This is a first milestone, **not yet a stable or published reusable action**. Next: robust multi-job artifact discovery, historical baselines and coverage-delta comparisons, reusable action packaging, and integration tests for fork PRs.

License: MIT.
