# Benchmark — PR Quality Report

**Benchmark** is an open-source tool that turns existing GitHub Actions results into an automatically updated pull-request quality report. It deliberately **does not rerun your tests**.

## First milestone

The current MVP provides:
- LCOV line, function and branch coverage parsing.
- JUnit XML and Jest JSON test-summary parsing.
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
3. The reporter runs **after** CI completes, so it can report failed workflows. It checks out trusted Benchmark code, never executes PR code with a write token, and uses `issues: write` to create or update one comment. Its PR resolution is SHA-checked; if it cannot confidently associate a run with the current PR head, it skips posting.

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

## Security model

The reporter uses the trusted default-branch workflow via `workflow_run`. Untrusted artifacts are read **only as bounded text/metrics**, never executed. The publisher resolves the PR through GitHub and checks the run's head SHA against the current PR head to prevent a stale or unrelated run posting. Do not replace the reporter's checkout with a checkout of the untrusted PR. Keep the reporting workflow on the default branch.

This is a first milestone, **not yet a stable or published reusable action**. Next: robust multi-job artifact discovery, historical baselines and coverage-delta comparisons, reusable action packaging, and integration tests for fork PRs.

License: MIT.
