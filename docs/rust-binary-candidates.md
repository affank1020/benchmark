# Rust native release candidates (issue #17, first slice)

The `Rust binary candidates` GitHub Actions workflow exercises the Rust Benchmark CLI on **native** runner platforms without publishing a release or changing installed consumers.

| Candidate target | GitHub-hosted runner | Status |
| --- | --- | --- |
| `linux-x64` | `ubuntu-24.04` | Read-only CI build/test/smoke |
| `darwin-arm64` | `macos-15` | Read-only CI build/test/smoke |
| `darwin-x64` | `macos-15-intel` | Read-only CI build/test/smoke |
| `linux-arm64` | Not yet enabled | Unsupported pending separate runner validation |
| Windows | Not yet enabled | Unsupported pending separate packaging validation |

The workflow installs pinned Rust **1.85.1**, runs `cargo test --locked --all-targets`, builds `cargo build --locked --release --bin benchmark`, and smoke-tests a native JUnit report with missing coverage and failed CI. Node is used only to package/verify the native candidate. No consumer tests are rerun by the Benchmark CLI.

Each artifact has the format `rust-candidate-<target>` and contains `SHA256SUMS`, a detached JSON manifest and `benchmark-rust-<40-char-source-SHA>-<target>.tar.gz`. The tarball contains **only** `benchmark-rust/benchmark`, `benchmark-rust/manifest.json` and a candidate README. The manifest records `kind: unreleased-ci-candidate`, Git commit, target, Rust toolchain, binary size and SHA-256; the packager rejects mismatched ELF/Mach-O executable architecture. The verifier checks file inventory, detached and archived manifest identity, binary bytes and both asset hashes without executing the archive.

**Important:** This is **not an official release** or a cryptographically authenticated artifact by itself. The source is whatever the unprivileged CI run checked out (including a PR merge commit), so its build output must never be downloaded and executed from a privileged `workflow_run` publisher. SHA256SUMS verifies internal integrity; it does **not** establish the origin or trust of a downloaded bundle. Only promote binaries after independently reviewing the **exact** tagged commit, release pipeline permissions, and authenticated artifact provenance.

## Developer commands

On a clean checkout with the desired reviewed Git commit:

```bash
rustup toolchain install 1.85.1 --profile minimal
cargo +1.85.1 test --locked --all-targets
cargo +1.85.1 build --locked --release --bin benchmark

COMMIT="$(git rev-parse HEAD)"
node scripts/package-rust-candidate.mjs --out-dir /tmp/benchmark-rust-candidate --commit "$COMMIT"
node scripts/verify-rust-candidate.mjs --out-dir /tmp/benchmark-rust-candidate --commit "$COMMIT"
```

The candidate output directory must be empty. These scripts reject malformed SHA inputs, dirty tracked source, wrong native platform/architecture, missing or oversized executables, altered manifests and checksum mismatches. Verify against the expected **commit and target** before trusting any file.

## Follow-up work before release

1. Independently review candidate packaging and matrix evidence; confirm each runner actually emitted a valid executable candidate. Check that a real post-merge Benchmark PR received one correctly updated Rust-generated comment.
2. Implement an **official** Rust GitHub Release promotion path with verified annotated tags, immutable source identity, distinct read-only native builds, authenticated binary provenance and least-privilege publication. Preserve the existing `v0.1.0` Node archive and old workflow pins; do not overwrite or retag it.
3. Validate a disposable external consumer on deliberately pinned, reviewed versions and a documented rollback. Upgrade production Atlas only after explicit separate review.
4. Decide how to collect trustworthy Rust coverage. Existing CI LCOV covers Node source files only; it must not be presented as coverage of Rust files.
5. Retire the legacy Node CLI only after all supported consumers have been migrated or retained compatible published versions.

The legacy annotated-tag release machinery in `.github/workflows/release.yml` and `scripts/package-release.mjs` is intentionally untouched. This initial slice does not silently bump `package.json` or `Cargo.toml` from 0.1.0, create tags or mutate any GitHub Release.
