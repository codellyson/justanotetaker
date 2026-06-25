#!/usr/bin/env bash
# Cut a new desktop release end-to-end.
#
#   pnpm release            # auto-bump the patch version (0.3.0 -> 0.3.1)
#   pnpm release 0.4.0      # cut an explicit version
#   pnpm release -y         # auto-bump, skip the confirmation prompt
#
# Performs: pre-flight checks (clean tree, on main, in sync with origin) ->
# bump version in src-tauri/tauri.conf.json + Cargo.toml -> refresh Cargo.lock
# -> commit "chore(release): vX.Y.Z" -> tag -> push commit + tag.
#
# The tag push fires release.yml: tauri-action builds the .dmg/.exe and
# publishes them to the GitHub Release, and the in-app updater picks them up.
# (Releases publish directly now — releaseDraft is false — so releases/latest
# resolves to the new version.)

set -euo pipefail
cd "$(dirname "$0")/.."

ASSUME_YES=0
NEXT=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    *)        NEXT="$arg" ;;
  esac
done

# ─── Pre-flight ────────────────────────────────────────────────────────

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ Working tree not clean. Commit or stash first." >&2
  git status --short >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "✗ On branch '$BRANCH'. Releases must be cut from main." >&2
  exit 1
fi

# Local main must match origin/main so the tag points where we expect.
git fetch origin main --quiet
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "✗ main is not in sync with origin. Pull or push first." >&2
  exit 1
fi

# ─── Compute the next version ──────────────────────────────────────────

CURRENT="$(awk -F'"' '/"version":/ {print $4; exit}' src-tauri/tauri.conf.json)"

if [[ -z "$NEXT" ]]; then
  IFS='.' read -r MAJ MIN PAT <<< "$CURRENT"
  NEXT="$MAJ.$MIN.$((PAT + 1))"
fi

if [[ ! "$NEXT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "✗ Invalid version: '$NEXT' (expected X.Y.Z)" >&2
  exit 1
fi

TAG="v$NEXT"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "✗ Tag $TAG already exists." >&2
  exit 1
fi

echo "→ Cutting $CURRENT → $NEXT (tag $TAG)"

if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "  Proceed? [y/N] " REPLY
  [[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

# ─── Bump version files ────────────────────────────────────────────────

# -i.bak for BSD/GNU sed portability, then remove the backup. The Cargo.toml
# pattern anchors to ^version so it only hits the [package] version, not the
# inline version="…" fields on dependency lines.
sed -i.bak -E "s/^version = \"[0-9.]+\"$/version = \"$NEXT\"/" src-tauri/Cargo.toml && rm src-tauri/Cargo.toml.bak
sed -i.bak "s/\"version\": \"$CURRENT\"/\"version\": \"$NEXT\"/" src-tauri/tauri.conf.json && rm src-tauri/tauri.conf.json.bak

echo "→ Refreshing Cargo.lock…"
(cd src-tauri && cargo check --message-format=short 2>&1 | tail -2)

# ─── Commit, tag, push ─────────────────────────────────────────────────

echo "→ Commit + tag + push…"
git add src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock
git commit -m "chore(release): $TAG"
git tag "$TAG"
git push origin main
git push origin "$TAG"

echo
echo "✓ Released $TAG"
echo "  • Watch the build:  gh run watch \$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status"
echo "  • Release page:     https://github.com/codellyson/justnotetaking/releases/tag/$TAG"
