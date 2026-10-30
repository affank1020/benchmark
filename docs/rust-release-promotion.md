# Manual promotion of reviewed Rust binaries

This workflow is deliberately separate from the existing `Publish Benchmark Release` workflow, whose [v0.1.0](https://github.com/affank1020/benchmark/releases/tag/v0.1.0) Node CLI archive and already-pinned consumers must continue working.

## Entry point and prerequisites

[Publish reviewed Rust binaries](../.github/workflows/rust-release.yml) has **only** a manual `workflow_dispatch` entry point. It will run only when dispatched on `main`. No ordinary PR, branch push, tag push, merge or CI artifact can automatically promote binaries.

Before any manual dispatch:

1. Independently review and merge the release workflow, native packaging scripts and the **v0.2.0** version-alignment PR. Confirm main-branch CI and the three native candidate jobs passed for the **specific reviewed SHA**. The new read-only `node scripts/check-rust-release-readiness.mjs --version v0.2.0` checks matching `package.json`, `Cargo.toml` and root `Cargo.lock` metadata; it does not establish GitHub authenticity or create anything. Do not tag until the independent review is complete.
2. **Only after a deliberate owner decision**, create an **annotated**, never-before-used `v0.2.0` tag (never reuse `v0.1.0`) on the reviewed commit of `main`, after checking that the remote tag is absent and resolving the exact SHA. A tag push triggers the **separate existing Node release publisher**, which publishes the Node CLI and pinned workflow assets. Merging the readiness PR does **not** trigger it.

   ```bash
   git fetch origin main --tags
   git switch main && git pull --ff-only origin main
   node scripts/check-rust-release-readiness.mjs --version v0.2.0
   git ls-remote --tags origin refs/tags/v0.2.0
   # The previous command MUST print no tag, and main's CI must be green.
   REVIEWED_SHA="$(git rev-parse HEAD)"
   git tag -a v0.2.0 "$REVIEWED_SHA" -m "Benchmark v0.2.0"
   git push origin refs/tags/v0.2.0
   ```

   A reviewer must inspect the resolved SHA and prior `git ls-remote` output before approving the **explicit tag push**. Never recreate or move an existing release tag.
3. Confirm the Node GitHub Release for this exact tag exists and is healthy, with its five expected assets, `release-manifest.json` committing to `REVIEWED_SHA` and a valid original `SHA256SUMS`. Do not bypass the annotated-tag/ancestry/identity checks or move an existing tag.
4. **Separately** dispatch the Rust workflow against `main` with exactly that existing `version_tag` after the Node release is verified. The Rust workflow rechecks the annotated commit and cross-language version alignment before building, and preserves the Node assets unchanged:

```bash
gh workflow run rust-release.yml --repo affank1020/benchmark --ref main -f version_tag=v0.2.0
```

**These are operator commands, not actions performed by the PR.** No tag or release is created by this version-bump PR or its tests. Even a successful Rust release does not update the existing Atlas or other consumer workflow pins. Check all Rust archives/JSON files and `rust-SHA256SUMS` before any consumer experiment.

## Trust boundary and distribution

The read-only `verify-tag` job checks the remote **annotated tag**, main ancestry, canonical version, and existing Node release, then emits the exact tagged source SHA.

Three independent native build jobs (`ubuntu-24.04` Linux x64, `macos-15` macOS arm64, `macos-15-intel` macOS x64) each checkout **that exact SHA**, not a PR head or mutable branch. They test locked Rust source and package a **new isolated Cargo build** with pinned Rust 1.85.1. The package scripts verify the executable's ELF/Mach-O architecture, exact commit, content hashes, tar member types and executable mode. They upload one same-run, short-lived `rust-release-<target>` artifact per platform.

The separate Linux publisher uses `contents: write` only after **all** native jobs pass. It independently re-verifies the remote annotated tag and exact SHA, downloads **only the three named artifacts from its own manual run**, and re-checks tar structure, every binary digest, target and tagged version. The publisher **does not execute a downloaded binary**.

It uploads six uniquely named source-SHA/target assets (archive + detached JSON manifest for each target) plus `rust-SHA256SUMS` to the **already existing version**. Its upload fails if any of those names already exist. It never uses `--clobber`, changes existing `SHA256SUMS`, retags, creates another release, or modifies a consumer. A runtime `--kind rust-release` marker distinguishes official assets from **untrusted PR CI candidates**.

**Important limitations:** Per-file SHA-256 and a GitHub Release uploaded by the reviewed workflow establish internal integrity and intended source identity, but this PR does **not** implement independent Sigstore/SLSA binary attestations or reproducible-build proofs. The same-run GitHub Actions build artifacts are trusted only within this explicitly reviewed manual workflow, never via a `workflow_run` accepting PR-supplied artifacts. Runtime verification of the privileged publisher is **not possible on PR CI**; it requires a later deliberate new annotated tag and release. GitHub repository protections and tag policies must be configured separately.

## Verified offline consumer installation (no auto-upgrade)

Only **after** a reviewed version has been explicitly tagged, the manual release workflow has published its official assets, and the exact tagged commit is independently known, use a checkout of this install script from the **reviewed source commit**:

```bash
# Illustrative values only; a v0.2.0 release has not been created by this PR.
TAG=v0.2.0
SHA=REPLACE_WITH_THE_REVIEWED_40_CHARACTER_TAG_COMMIT
TARGET=linux-x64   # For a Linux x64 consumer; use darwin-arm64 / darwin-x64 on macOS
mkdir -p ./benchmark-download
gh release download "$TAG" --repo affank1020/benchmark \
  --dir ./benchmark-download \
  --pattern "rust-SHA256SUMS" \
  --pattern "benchmark-rust-$SHA-$TARGET.tar.gz" \
  --pattern "benchmark-rust-$SHA-$TARGET.json"

node scripts/install-rust-release.mjs \
  --assets-dir ./benchmark-download --version "$TAG" \
  --commit "$SHA" --dest "./benchmark-installed-$TAG"
./benchmark-installed-$TAG/benchmark --tests ./test/fixtures/node22-junit.xml --ci failure
```

The installer supports **linux-x64, darwin-arm64 and darwin-x64** on the matching native host. It requires exactly the archive, detached JSON manifest and complete six-entry `rust-SHA256SUMS`. It checks SHA-256 digests, the complete expected platform inventory, exact source commit and version, the `rust-release` kind, architecture, tar member modes and executable permissions, and the embedded manifest/binary identity. It then writes the verified executable plus an `installation.json` receipt to a **new, previously nonexistent** destination. It never automatically executes the binary and refuses to overwrite an installation. The persisted `installation.json` receipt explicitly records **caller-supplied offline assets; origin not authenticated**, alongside the checked version, commit, target and binary SHA-256. A caller must independently review the source/release identity and supply the expected SHA; the checksums and receipt alone are **not independent evidence of signing, provenance, or GitHub repository authenticity**.

For rollback, retain the previously reviewed executable and consumer workflow SHA. Restore those explicit paths/pins and rerun CI; do not move `v0.1.0` or retag any release. A real separate-repository test consumer (including its fork/rerun paths) is **still required** before a production Atlas upgrade.

## Failure and rollback

If tag validation, native builds, archive verification or any pre-upload identity check fails, **nothing new should be uploaded**. If GitHub upload fails partway through, a partial Rust asset set might exist: the job refuses to overwrite on retry. An owner must inspect the exact uploaded assets and original job logs, then choose a reviewed manual recovery; do **not** automatically delete, overwrite or retag any assets.

Keep consumers at their previously reviewed immutable workflows (including existing Atlas pins). To roll back after an explicitly reviewed consumer adoption, restore the older workflow SHA and rerun CI. Never point a privileged publisher at a moving branch or at an untrusted PR candidate archive.

After successful release publication, validate each platform's binary and manifest hashes independently against `rust-SHA256SUMS` and the expected tagged commit before executing. Validate a disposable external GitHub Actions consumer and one rollback **before** upgrading production Atlas or considering removal of the legacy Node CLI.

## Coverage

Benchmark's original JUnit and LCOV CI artifacts currently measure Node source files. The Rust source is tested, but **Node 96% coverage is not Rust coverage**. Rust coverage generation and a correct comparable source inventory remain separate acceptance criteria under [#17](https://github.com/affank1020/benchmark/issues/17).
