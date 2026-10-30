# Manual promotion of reviewed Rust binaries

This workflow is deliberately separate from the existing `Publish Benchmark Release` workflow, whose [v0.1.0](https://github.com/affank1020/benchmark/releases/tag/v0.1.0) Node CLI archive and already-pinned consumers must continue working.

## Entry point and prerequisites

[Publish reviewed Rust binaries](../.github/workflows/rust-release.yml) has **only** a manual `workflow_dispatch` entry point. It will run only when dispatched on `main`. No ordinary PR, branch push, tag push, merge or CI artifact can automatically promote binaries.

Before any manual dispatch:

1. Independently review and merge the release workflow, native packaging scripts and intended version bump. Confirm main-branch CI and native candidate tests passed.
2. Explicitly create an **annotated**, never-before-used `vX.Y.Z` tag (not `v0.1.0`) pointing to a reviewed commit on `main` whose `package.json` version matches and includes these scripts. A tag push triggers the **separate original Node release publisher**, which publishes its legacy assets.
3. Confirm the Node GitHub Release for this exact tag exists and is healthy. Do not bypass its signature/ancestry/identity checks or move an existing tag.
4. Deliberately dispatch the new Rust workflow against `main` with exactly that existing `version_tag`. For example, after a new reviewed tag has been published:

```bash
gh workflow run rust-release.yml --repo affank1020/benchmark --ref main -f version_tag=v0.2.0
```

The example version is **illustrative, not created or released by this PR**. Merely merging the PR does not create a tag, release, or consumer update.

## Trust boundary and distribution

The read-only `verify-tag` job checks the remote **annotated tag**, main ancestry, canonical version, and existing Node release, then emits the exact tagged source SHA.

Three independent native build jobs (`ubuntu-24.04` Linux x64, `macos-15` macOS arm64, `macos-15-intel` macOS x64) each checkout **that exact SHA**, not a PR head or mutable branch. They test locked Rust source and package a **new isolated Cargo build** with pinned Rust 1.85.1. The package scripts verify the executable's ELF/Mach-O architecture, exact commit, content hashes, tar member types and executable mode. They upload one same-run, short-lived `rust-release-<target>` artifact per platform.

The separate Linux publisher uses `contents: write` only after **all** native jobs pass. It independently re-verifies the remote annotated tag and exact SHA, downloads **only the three named artifacts from its own manual run**, and re-checks tar structure, every binary digest, target and tagged version. The publisher **does not execute a downloaded binary**.

It uploads six uniquely named source-SHA/target assets (archive + detached JSON manifest for each target) plus `rust-SHA256SUMS` to the **already existing version**. Its upload fails if any of those names already exist. It never uses `--clobber`, changes existing `SHA256SUMS`, retags, creates another release, or modifies a consumer. A runtime `--kind rust-release` marker distinguishes official assets from **untrusted PR CI candidates**.

**Important limitations:** Per-file SHA-256 and a GitHub Release uploaded by the reviewed workflow establish internal integrity and intended source identity, but this PR does **not** implement independent Sigstore/SLSA binary attestations or reproducible-build proofs. The same-run GitHub Actions build artifacts are trusted only within this explicitly reviewed manual workflow, never via a `workflow_run` accepting PR-supplied artifacts. Runtime verification of the privileged publisher is **not possible on PR CI**; it requires a later deliberate new annotated tag and release. GitHub repository protections and tag policies must be configured separately.

## Failure and rollback

If tag validation, native builds, archive verification or any pre-upload identity check fails, **nothing new should be uploaded**. If GitHub upload fails partway through, a partial Rust asset set might exist: the job refuses to overwrite on retry. An owner must inspect the exact uploaded assets and original job logs, then choose a reviewed manual recovery; do **not** automatically delete, overwrite or retag any assets.

Keep consumers at their previously reviewed immutable workflows (including existing Atlas pins). To roll back after an explicitly reviewed consumer adoption, restore the older workflow SHA and rerun CI. Never point a privileged publisher at a moving branch or at an untrusted PR candidate archive.

After successful release publication, validate each platform's binary and manifest hashes independently against `rust-SHA256SUMS` and the expected tagged commit before executing. Validate a disposable external GitHub Actions consumer and one rollback **before** upgrading production Atlas or considering removal of the legacy Node CLI.

## Coverage

Benchmark's original JUnit and LCOV CI artifacts currently measure Node source files. The Rust source is tested, but **Node 96% coverage is not Rust coverage**. Rust coverage generation and a correct comparable source inventory remain separate acceptance criteria under [#17](https://github.com/affank1020/benchmark/issues/17).
