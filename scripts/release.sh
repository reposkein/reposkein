#!/usr/bin/env bash
# Cut a RepoSkein release: sync the version across the Rust workspace + the npm
# package + lockfiles, refresh the changelog, commit, and tag. Then push with
# --follow-tags to trigger .github/workflows/release.yml (builds the 5 platform
# binaries, creates the GitHub Release, publishes @reposkein/mcp).
#
#   scripts/release.sh 0.1.0
#   git push --follow-tags origin main
#
# The npm postinstall fetches the indexer binary for v<version>, so the npm
# package version MUST equal the release tag — this script keeps them in sync.
set -euo pipefail

VERSION="${1:?usage: scripts/release.sh <version>   (e.g. 0.1.0)}"
VERSION="${VERSION#v}"
TAG="v${VERSION}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- Preconditions -----------------------------------------------------------
[ -z "$(git status --porcelain)" ] || { echo "error: working tree not clean — commit or stash first." >&2; exit 1; }
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || { echo "error: not on main (on '$BRANCH')." >&2; exit 1; }
if git rev-parse "$TAG" >/dev/null 2>&1; then echo "error: tag $TAG already exists." >&2; exit 1; fi

echo "Releasing ${TAG}"

# --- 1) Rust workspace version ([workspace.package] version = "...") ---------
perl -0pi -e 's/(\[workspace\.package\][^\[]*?\bversion\s*=\s*")[^"]*(")/${1}'"$VERSION"'${2}/s' indexer/Cargo.toml
( cd indexer && cargo update --workspace --offline >/dev/null 2>&1 \
  || cargo update --workspace >/dev/null 2>&1 || true )   # sync Cargo.lock member versions

# --- 2) npm package version --------------------------------------------------
( cd mcp && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null )

# --- 3) Changelog ------------------------------------------------------------
if command -v git-cliff >/dev/null 2>&1; then
  git-cliff --tag "$TAG" -o CHANGELOG.md
  echo "  CHANGELOG.md regenerated via git-cliff"
else
  echo "  note: git-cliff not installed — edit CHANGELOG.md by hand (move 'Unreleased' to ${TAG})."
  echo "        ('brew install git-cliff' or 'cargo install git-cliff' to automate it.)"
fi

# --- 4) Commit + tag ---------------------------------------------------------
git add indexer/Cargo.toml indexer/Cargo.lock mcp/package.json mcp/package-lock.json CHANGELOG.md
git commit -m "chore(release): ${TAG}"
git tag -a "$TAG" -m "$TAG"

cat <<EOF

Tagged ${TAG}. Verify, then push to trigger the release pipeline:

  git push --follow-tags origin main

(The release workflow builds the 5 platform binaries, attaches them to the
GitHub Release for ${TAG}, and publishes @reposkein/mcp@${VERSION}.)
EOF
