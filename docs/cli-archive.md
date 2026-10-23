# Benchmark CLI

This archive contains the **dependency-free Benchmark CLI**, not the full GitHub repository. It includes the runtime source, package metadata, and licence. Tests, GitHub Actions workflows, examples and developer documentation are available online.

## Requirements

Node.js **22.6.0 or later**. Run the following commands from the extracted `benchmark-vX.Y.Z/` directory. No dependency installation is needed.

## Generate a report

```bash
node --experimental-strip-types src/cli.mjs \
  --coverage /path/to/lcov.info \
  --tests /path/to/junit.xml \
  --ci success \
  --output benchmark-report.md \
  --json benchmark-report.json
```

To compare coverage against a baseline, add `--baseline-coverage /path/to/base-lcov.info`. For Jest JSON test results, add `--tests-format jest`.

Missing or invalid input files are reported as unavailable rather than guessed as passing or zero coverage. A successful CLI exit means the report was rendered, **not** that the underlying CI passed.

## Source and integration documentation

- [Benchmark source repository](https://github.com/affank1020/benchmark)
- [Full usage and CI integration guide](https://github.com/affank1020/benchmark#readme)
- [Consumer workflow examples](https://github.com/affank1020/benchmark/tree/main/examples)
- [Release and rollback procedure](https://github.com/affank1020/benchmark/blob/main/docs/releasing.md)

**Developer tests are not included in this CLI distribution.** To run the test suite, use a full checkout of the source repository instead.
