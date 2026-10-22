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

## Multi-job CI artifacts (independent JUnit and LCOV jobs)

Benchmark accepts separate artifacts from different jobs within the **same completed CI workflow run**, without rerunning tests. The legacy combined `benchmark-ci` artifact works unchanged. The trusted publisher selects each artifact by **unique exact name**, validates artifact IDs and compressed size (up to 25 MiB per input), then downloads JUnit and LCOV into isolated paths so filenames cannot overwrite each other.

In a reviewed release of the [reusable reporter](.github/workflows/reusable-report.yml), the caller can specify:

```yaml
with:
  artifact_name: benchmark-ci
  tests_artifact_name: ci-junit
  coverage_artifact_name: ci-lcov
```

The read-only PR CI workflow uploads `junit.xml` at the root of `ci-junit` and `lcov.info` at the root of `ci-lcov`. The **exact-base** comparison looks for the same `ci-lcov` artifact in the successful base-branch push CI. Both optional names default to `artifact_name`. Missing, expired, oversized or duplicate artifacts remain unavailable rather than being guessed or silently replaced.

For the full workflow example, configure `BENCHMARK_TESTS_ARTIFACT_NAME`, `BENCHMARK_COVERAGE_ARTIFACT_NAME`, and the baseline's `BENCHMARK_ARTIFACT_NAME` together. Consumers with older immutable workflow pins continue using combined artifacts until they explicitly upgrade to a reviewed new release.

## Early status comment lifecycle

To give contributors feedback before tests finish, install the [trusted CI-start lifecycle workflow](examples/lifecycle-pr.yml) alongside the [post-CI publisher](examples/report-pr.yml). **Both use default-branch `workflow_run`** events: the lifecycle listens for the read-only CI workflow's `requested` and `in_progress` events, while the reporter listens for `completed`. This replaces the prior `pull_request_target` approach, which received HTTP 403 on its first live comment attempts despite its declared `issues: write` scope.

The first waiting comment appears when CI is requested or starts, **not necessarily immediately when the PR opens**. GitHub does not emit `requested` on reruns, so `in_progress` also handles them. Before writing, Benchmark resolves one current open PR by source repository ID, branch and SHA (including forks), verifies the live CI run/attempt, and rejects stale or completed attempts. The lifecycle checks out only an **immutable reviewed Benchmark PR-matching implementation**, never untrusted PR code. PR CI remains read-only.

The same bot-owned comment moves through **Waiting for CI results → Processing CI results → Final quality report**. Reporting failures may become **Report unavailable**, and the always-running reconciliation handles successful-but-skipped reports. Both trusted workflows share a source-identity concurrency group and record PR head plus CI run ID/attempt to avoid duplicate or stale updates. Both must set `queue: max` with `cancel-in-progress: false`: GitHub's default one-pending-run policy can otherwise evict an already queued final report when a delayed CI-start webhook arrives. Queuing retains up to 100 pending runs per source group; GitHub may still cancel overflow and does not promise webhook order. The start workflow rechecks the live CI state so delayed events cannot downgrade a completed report. Rapid CI, GitHub Actions scheduling, fork approvals, or cancellations can skip intermediate phases; the completed reporter remains able to create the final comment.

For consumers, copy `examples/lifecycle-pr.yml` to `.github/workflows/benchmark-lifecycle.yml` on the default branch and set `workflows: [CI]` to the exact existing CI workflow name. Deploy the enhanced post-CI publisher from a **reviewed immutable release**, not `@main`. Earlier consumers pinned to PR #6 still publish final reports but lack intermediate states.

**Live verification:** the superseded `pull_request_target` workflow failed on Benchmark PRs #9 and #10. The CI-start replacement cannot validate itself while unmerged. After merging, create/update a PR and verify Waiting → Processing → Final edits **the same comment ID**. Test forks and reruns, and record Actions run IDs, effective permissions and any 403 before claiming this is resolved.

## Security model

The reporter uses the trusted default-branch workflow via `workflow_run`, and its privileged implementation checkout is pinned to an immutable reviewed SHA rather than `main`. Untrusted artifacts are read **only as bounded text/metrics**, never executed. The publisher serializes report jobs per PR source and checks the run's current attempt, newest completed workflow run, and PR head SHA immediately before posting to avoid duplicate or stale reports. The parser also enforces a 10 MiB per-file read limit and the sample workflow checks compressed artifact size (25 MiB) before downloading. Do not replace the reporter's checkout with a checkout of the untrusted PR. Keep the reporting workflow on the default branch.

This is a first milestone, **not yet a stable or published reusable action**. Next: robust multi-job artifact discovery, historical baselines and coverage-delta comparisons, reusable action packaging, and integration tests for fork PRs.

License: MIT.
