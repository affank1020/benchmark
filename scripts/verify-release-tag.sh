#!/usr/bin/env bash
# Resolve an existing reviewed annotated release tag to its immutable commit.
# Called only after checking out the trusted default-branch release policy.
set -euo pipefail

fail() {
  printf 'Benchmark release verification failed: %s\n' "$*" >&2
  exit 1
}
[[ $# -eq 1 ]] || fail "Expected exactly one version tag argument"
TAG="$1"
[[ "$TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  fail "Expected a stable, canonical vX.Y.Z version tag"

case "${GITHUB_EVENT_NAME:-}" in
  push)
    [[ "${GITHUB_REF_TYPE:-}" == "tag" && "${GITHUB_REF:-}" == "refs/tags/$TAG" ]] ||
      fail "Tag-push identity does not match the requested version"
    ;;
  workflow_dispatch)
    [[ "${GITHUB_REF:-}" == "refs/heads/main" ]] ||
      fail "Recovery is only permitted when dispatched from main"
    ;;
  *)
    fail "Unsupported release event"
    ;;
esac

# actions/checkout on a tag-push event can leave a *lightweight* tag ref
# pointing to GITHUB_SHA, even if the remote object is annotated.
# Re-fetch the original remote ref explicitly before enforcing the type.
git fetch --force --no-tags origin "+refs/tags/$TAG:refs/tags/$TAG"
[[ "$(git cat-file -t "refs/tags/$TAG")" == "tag" ]] ||
  fail "The remote release tag must be annotated, not lightweight"

tag_commit="$(git rev-parse --verify "refs/tags/$TAG^{commit}")"
[[ "$tag_commit" =~ ^[0-9a-f]{40}$ ]] ||
  fail "Could not resolve an exact release commit"

if [[ "${GITHUB_EVENT_NAME}" == "push" ]]; then
  [[ "${GITHUB_SHA:-}" == "$tag_commit" ]] ||
    fail "The pushed release commit does not match the annotated tag"
fi

# Reject tags created off-main; never fall back to a different branch/SHA.
git fetch --no-tags origin "+refs/heads/main:refs/remotes/origin/main"
git merge-base --is-ancestor "$tag_commit" refs/remotes/origin/main ||
  fail "Release tag commit is not reachable from reviewed main"

# Preserve exact identity: subsequent packaging reads HEAD and git archive at
# the verified commit. Nothing here creates, deletes or updates remote tags.
git checkout --detach "$tag_commit"
[[ "$(git rev-parse HEAD)" == "$tag_commit" ]] ||
  fail "Checked-out source does not match verified release commit"
version="$(node -p "require('./package.json').version")"
[[ "$TAG" == "v$version" ]] ||
  fail "The annotated tag does not match the tagged package.json version"
printf 'Verified annotated release %s at %s\n' "$TAG" "$tag_commit"
