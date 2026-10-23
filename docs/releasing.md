# Benchmark release procedure

This project publishes **GitHub Releases**, not npm packages. The CLI remains dependency-free, and the consumer workflow permissions are deliberately isolated from PR CI.

## Pre-release checklist

1. Have the release changes independently reviewed and merged to `main`; do not release an unreviewed PR head.
2. Confirm the full test suite and main-branch CI passed for the intended SHA. Confirm `package.json` has the desired **stable** version, for example `0.1.0`.
3. Check that no protected release tag already exists. Create an **annotated** tag on the reviewed main commit: `git tag -a v0.1.0 <reviewed-main-SHA> -m 'Benchmark v0.1.0'`; then deliberately push it: `git push origin v0.1.0`. This is a privileged release action and is not performed by an ordinary PR.
4. The [release workflow](../.github/workflows/release.yml) checks out the reviewed default-branch release policy, **re-fetches the remote annotated tag object**, verifies its exact version and ancestry from `main`, and switches to the tag's **original exact commit** before packaging. It verifies `SHA256SUMS`, then calls `gh release create --verify-tag` against the existing tag. The source of the tag is never rewritten.
5. Review the [GitHub Releases](https://github.com/affank1020/benchmark/releases) page and the workflow run. Check `release-manifest.json` for the version and 40-character commit SHA. Verify downloaded asset bytes with `sha256sum -c SHA256SUMS` from the download directory.

## Recover an already-pushed tag after a failed publish

An existing annotated tag must **never be deleted, moved, or force-pushed** just because the release job failed. First have any release workflow fix independently reviewed and merged to `main`. The recovery entrypoint runs the new **trusted `main` policy** against the existing tag, even if that tag points to an older reviewed commit.

From GitHub, open **Actions → Publish Benchmark Release → Run workflow**, select the **`main`** branch, and supply the existing `version_tag` (for example `v0.1.0`). Equivalent GitHub CLI command:

```bash
gh workflow run release.yml --repo affank1020/benchmark --ref main -f version_tag=v0.1.0
```

Recovery is allowed only when the workflow is dispatched from `refs/heads/main`. Both dispatch and tag-push execution enforce canonical stable `vX.Y.Z` names, re-fetch and verify the actual **annotated** remote tag object, ensure the exact tagged commit belongs to reviewed `main`, and validate its `package.json` version. Tag pushes additionally require the GitHub event SHA to equal that commit. The trusted checker runs **before** switching to the tagged source; the CLI archive and workflow pins are then generated from that original tagged source.

After success, check the release's `release-manifest.json` commit, five asset names, and `SHA256SUMS`. Do not dispatch again for an already-published version; repeated publication must fail instead of overwriting assets.

## Output files

- `benchmark-cli-vX.Y.Z.tar.gz`: only the CLI runtime (`src/`, package metadata, LICENSE) and a CLI-specific `README.md` with online documentation links; requires Node.js >=22.6. Developer tests, repository workflows and local docs are excluded.
- `benchmark-report.yml`: completed-CI consumer `workflow_run` caller, pinned to this release's exact commit, with combined artifact mode by default and optional split input names.
- `benchmark-lifecycle.yml`: trusted CI-start handler, with its trusted policy checkout pinned to this release's exact commit.
- `release-manifest.json`: machine-readable release version, commit SHA and SHA256/byte metadata.
- `SHA256SUMS`: integrity hashes for all four assets; does not authenticate the publisher on its own.

## Consumer adoption

Copy the two YAML files into `.github/workflows/` in the consumer repository **only after review**. Update each `workflows: [CI]` filter to match the consumer's existing PR CI workflow name. Keep CI itself read-only; only the trusted lifecycle and reporter workflows receive write access to PR comments. The reporter runs the producer's existing test results, never PR code with a write token.

Consumers currently pinned to a prior SHA continue working until they intentionally update. For split-job reporting, set `tests_artifact_name` and `coverage_artifact_name` in the caller and ensure each CI artifact contains `junit.xml` or `lcov.info` at its root. Verify both exact-base coverage comparisons and fork-originated PRs using [the validation checklist](consumer-validation.md).

**Rollback:** revert the consumer's two workflow files to their previously reviewed SHA pins. Do not move or overwrite a published version tag to roll back. Tag protections and GitHub Release immutability should be configured by the repository owner; the build cannot enable those repository policies.

## Limits

No release is created on PR, ordinary branch push, or merge. An existing annotated version tag is required, and recovery must be explicitly dispatched from `main`. GitHub Releases may require repository permissions or environment policies beyond this workflow. CI on a PR tests packaging locally but cannot itself verify the privileged publish step; verify that after the first controlled release.
