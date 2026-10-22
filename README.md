# Benchmark — PR Quality Report

**Benchmark** is an open-source tool that turns existing GitHub Actions results into an automatically updated pull-request quality report. It deliberately **does not rerun your tests**.

## First milestone

The current MVP provides:
- LCOV line, function and branch coverage parsing, with optional comparisons against a supplied LCOV baseline.
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

## Coverage comparison (manual and automatic baseline)

For local runs, use `--baseline-coverage PATH` to compare current LCOV metrics against an explicitly supplied baseline LCOV file. BENCHMARK's post-CI GitHub workflows can also **automatically discover the baseline** from a successful `push` run of the **same CI workflow** on the PR's exact current base-branch SHA. Both paths use the same bounded CLI LCOV parser.

```bash
node --experimental-strip-types src/cli.mjs \
  --coverage ./coverage/current/lcov.info \
  --baseline-coverage ./coverage/base/lcov.info \
  --ci success --json benchmark.json
```

Automatic baseline retrieval requires the consumer's `CI` workflow to run on both `pull_request` **and** `push` to the PR target branch (usually `main`), uploading a `benchmark-ci` artifact containing `lcov.info` from both runs. The publisher verifies the PR's current base repository, commit SHA and branch, searches only **completed push runs of the same workflow at that exact SHA**, and uses only one uniquely named, unexpired artifact under the existing 25 MiB compressed size limit, downloading by the exact artifact ID that passed validation. The ID-based download sets `merge-multiple: true` (with exactly one validated ID), so the extracted LCOV file resides at `baseline/lcov.info` rather than being nested under an artifact-name subdirectory. If the most recent matching run failed, no such run exists, or the artifact lacks coverage, no change is shown. It never substitutes an older base commit or runs tests itself. Base SHA and branch, the chosen base run ID and attempt, and the latest completed exact-base CI result are rechecked immediately before the comment is published, alongside existing head SHA and CI freshness checks.

The workflow's trusted BENCHMARK implementation checkout is pinned to the reviewed PR #4 merge (`81b6602198c38a74d6b539a484ff25b86c8e0cc8`). This version understands `--baseline-coverage`, unlike the older pin. Changes to the pinned implementation remain explicit, reviewable upgrades. Benchmark's own CI now generates both `junit.xml` and `lcov.info` from the **same Node.js 22 test execution** using Node's native JUnit and experimental LCOV reporters, with source coverage restricted to recursive `src/**/*.mjs` and `src/**/*.ts` (excluding tests and non-executable TypeScript declarations). The resulting files are uploaded together in the root of the `benchmark-ci` artifact on both PR and main-branch push runs. No coverage package or second test run is needed.

The Markdown report adds a baseline and change column. Change means **percentage points**, so a shift from 60% to 55% is **-5.00 pp**, not a 5% relative decline. The JSON includes `baselineCoverage` and a per-metric `coverageChange` object, whose values are percentage-point numbers or `null` if either denominator is unavailable. Zero measured lines/functions/branches must not be mistaken for 0% coverage.

The two input files must represent comparable source/file scopes and instrumentation for the difference to be meaningful. A missing, malformed or oversized baseline is reported as unavailable without changing the normal current coverage results. LCOV records with malformed, duplicated or incomplete summary counter pairs (for example `LF` without `LH`) are rejected instead of being zero-filled; this applies to current coverage too. Percentage-point differences are calculated from the original hit/found ratios and rounded once, so the displayed change may differ by 0.01 pp from subtracting the two separately rounded displayed rates. Both files are subject to the existing bounded-read limits. The GitHub Actions publishers also supply a baseline automatically when they can identify an exact successful base-branch CI run, unambiguously select and download its validated artifact by ID, and confirm immediately before publishing that the selected base run and attempt are still current and successful. If any check fails, the automatic comparison is withheld.

For Jest JSON summaries, add `--tests-format jest`. Paths may be omitted. Missing or unparseable files are reported as unavailable rather than falsely passing. Exit code zero means a report was rendered; it **does not indicate CI passed**.

```bash
npm test
```

No runtime or test dependencies.

## GitHub Actions integration

1. In your existing PR-triggered **CI** workflow, upload the coverage and test files as one artifact named `benchmark-ci`, containing `lcov.info` and `junit.xml` at its root. Use `if: always()` so the artifact is uploaded even when the test job fails. If no results exist, Benchmark will show those metrics as unavailable.
2. Copy [`examples/report-pr.yml`](examples/report-pr.yml) to `.github/workflows/benchmark-report.yml` in the consuming repository. Change `workflows: [CI]` to match your CI workflow's exact name. The full workflow example pins its trusted BENCHMARK implementation checkout to the reviewed PR #4 merge commit (`81b6602198c38a74d6b539a484ff25b86c8e0cc8`). Keep this immutable SHA unless deliberately upgrading to another reviewed commit.
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

For another repository, use the short [reusable reporter caller](examples/use-reusable-report.yml) rather than copying the full [publisher](examples/report-pr.yml). Follow the [external consumer and fork validation checklist](docs/consumer-validation.md) before production adoption. The consumer keeps a trusted `workflow_run` trigger on its default branch and grants `contents: read`, `actions: read`, `issues: write` and `pull-requests: write`. Configure `workflows: [CI]` to match the name of its existing pull-request CI workflow.

The caller needs only:

```yaml
jobs:
  report:
    if: github.event.workflow_run.event == 'pull_request'
    uses: affank1020/benchmark/.github/workflows/reusable-report.yml@bb128d710834af8f763eb116bfd768af9d326d9b
    with:
      artifact_name: benchmark-ci
```

**The caller is pinned to reviewed Benchmark PR #6 merge (`bb128d710834af8f763eb116bfd768af9d326d9b`)**, which includes the reusable workflow and its trusted reporter implementation. Never deploy the privileged caller using `@main` or another moving ref; review each pin upgrade explicitly. The reusable workflow independently checks out BENCHMARK's reviewed PR #4 merge (`81b6602198c38a74d6b539a484ff25b86c8e0cc8`) as its trusted reporter implementation. Advancing that pinned implementation is a deliberate compatibility/security change.

The consumer's own CI must upload an artifact named `benchmark-ci` (or the chosen `artifact_name`) containing `lcov.info` and `junit.xml` at its root. It should upload on failure (`if: always()`); missing inputs are represented as unavailable, never fabricated. The reusable workflow runs in the **consumer repository's** security context, not on PR-supplied code. No external installation or personal access token is required when the repository and workflow permissions allow reusable calls.

**Same-repository report publication and updating verified.** After the PR #3 permissions fix reached `main`, the installed `workflow_run` reporter processed PR #4's [successful CI run](https://github.com/affank1020/benchmark/actions/runs/39696508670) and [created a quality report comment as `github-actions[bot]`](https://github.com/affank1020/benchmark/pull/4#issuecomment-6329226920). A later CI run updated that same comment, and PR #5 also exercised the update path. The previous same-repository HTTP 403 is resolved. A separate consumer repository and a fork PR still require end-to-end verification before production adoption.

## Benchmark reporting on Benchmark

This repository installs its own [trusted reporting workflow](.github/workflows/benchmark-report.yml), matching the public [integration example](examples/report-pr.yml). Both check out the same immutable, reviewed Benchmark implementation SHA; an upgrade requires changing the pins explicitly and reviewing the new implementation. The workflow is on `main` and has successfully published and updated a same-repository PR comment. CI now collects source-only LCOV alongside JUnit in one test run, including the reporter inputs in the `benchmark-ci` artifact even when tests fail (when the underlying test runner produces the files). The CI smoke check verifies parseable nonempty source coverage whenever unit tests succeed. Native Node.js coverage is experimental and omits source files that are never executed. CI therefore compares LCOV `SF:` entries with every Git-tracked executable `src/**/*.mjs` and `src/**/*.ts` file (excluding `*.d.ts` declaration-only files) before accepting any coverage percentage. Missing, unexpected or duplicate source records make the smoke step fail and remove `lcov.info` **before the always-running artifact upload**, so Benchmark cannot present incomplete coverage as trustworthy. This deliberately requires tests to load new source modules before CI can pass. The regression tests exercise real Node reporter output, including an entirely unimported module, and verify that incomplete coverage is withheld. **The first automatic base comparison cannot be verified on this coverage-introducing PR**: its exact base SHA predates LCOV upload. After these changes reach `main` and its successful push CI uploads LCOV, a subsequent PR can verify a live base-branch comparison end-to-end.

Fork-originated `workflow_run` events may omit pull-request associations, and GitHub's commit lookup can miss fork-only SHAs. The publisher therefore also discovers open PRs by source repository owner and branch, and only accepts one with matching repository ID, branch, and commit SHA. Ambiguous or stale matches are skipped rather than posting to the wrong PR. This fallback is covered by mocked GitHub API regression tests; a live fork PR still needs verification after deployment.

The reporting workflow uses `workflow_run`, which GitHub only activates from the default branch. A change to the reporter workflow in a PR cannot validate its own publishing behaviour until merged; subsequent PRs exercise the end-to-end path. `test/workflow-contract.test.mjs` guards drift between the installed workflow and the example. For new repositories, follow the integration instructions below instead of copying the Benchmark-specific workflow without review.

## Early status comment lifecycle

To let contributors know Benchmark is working before CI finishes, enable the separate, trusted [PR lifecycle workflow](examples/lifecycle-pr.yml) alongside the [existing post-CI publisher](examples/report-pr.yml). The lifecycle workflow runs via `pull_request_target` on PR open/reopen/new commits, but **never checks out, installs, imports or executes the pull-request code**: it only validates the current PR against its event identity through GitHub's API, then creates or updates one bot-owned comment using the existing invisible marker.

The single comment moves through **Waiting for CI → Processing CI results → Final quality report**. A processing failure becomes **Report unavailable** with a link to the reporting workflow; a subsequent PR revision can recover using the same comment. Messages include the verified PR head SHA as private metadata to prevent delayed PR webhooks from replacing a newer status. The two workflows share a concurrency group, and the reporter still rechecks the current PR head, source CI attempt and exact base before writing. This is **not a live progress stream**: GitHub Actions job startup, first-time fork-run approvals, delayed webhook delivery or cancellation may delay or prevent updates.

For a **new consumer**, copy `examples/lifecycle-pr.yml` to `.github/workflows/benchmark-lifecycle.yml` on the default branch. Also deploy a **reviewed release** of the enhanced `reusable-report.yml` (or full reporter) pinned to its immutable 40-character SHA; an older reusable caller such as the PR #6 release continues to publish final reports but does not expose intermediate processing/error states. Both workflows must run under the same repository's Actions identity for a single editable comment. Only the lifecycle's trusted PR-event workflow needs `issues: write`; the existing PR CI remains `contents: read` only. Do not introduce `actions/checkout` of fork code, `pull_request_target` shell execution, or a moving privileged ref.

The lifecycle is inactive on this PR until its workflow reaches `main`, because GitHub only runs trusted `pull_request_target` and `workflow_run` workflows from the base repository's default branch. Verify the waiting and final in-place update on a subsequent PR, including a fork and a failed CI run.

## Security model

The reporter uses the trusted default-branch workflow via `workflow_run`, and its privileged implementation checkout is pinned to an immutable reviewed SHA rather than `main`. Untrusted artifacts are read **only as bounded text/metrics**, never executed. The publisher serializes report jobs per PR source and checks the run's current attempt, newest completed workflow run, and PR head SHA immediately before posting to avoid duplicate or stale reports. The parser also enforces a 10 MiB per-file read limit and the sample workflow checks compressed artifact size (25 MiB) before downloading. Do not replace the reporter's checkout with a checkout of the untrusted PR. Keep the reporting workflow on the default branch.

This is a first milestone, **not yet a stable or published reusable action**. Next: robust multi-job artifact discovery, historical baselines and coverage-delta comparisons, reusable action packaging, and integration tests for fork PRs.

License: MIT.
