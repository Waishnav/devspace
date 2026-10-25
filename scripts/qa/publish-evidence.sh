#!/usr/bin/env bash
# Publish QA screenshots for a pull request and print Markdown image links.
#
#   scripts/qa/publish-evidence.sh <pr-number> <image>...
#
# Images go to the orphan branch qa-evidence/pr-<number>, so evidence never
# touches code branches and can be deleted with the branch after merge.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <pr-number> <image>..." >&2
  exit 2
fi

pr="$1"
shift

# Names become URLs, so two files with one basename would silently share a link.
duplicates="$(for image in "$@"; do basename "$image"; done | sort | uniq -d)"
if [ -n "$duplicates" ]; then
  echo "duplicate image names; rename before publishing: $duplicates" >&2
  exit 2
fi
branch="qa-evidence/pr-${pr}"
remote_url="$(git remote get-url origin)"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git clone -q --depth 1 --branch "$branch" "$remote_url" "$work"
else
  git init -q "$work"
  git -C "$work" checkout -q --orphan "$branch"
  git -C "$work" remote add origin "$remote_url"
fi

# The temp dir suffix keeps two publications within one second apart.
stamp="$(date -u +%Y%m%dT%H%M%SZ)-${work##*/}"
mkdir -p "$work/$stamp"
for image in "$@"; do
  cp "$image" "$work/$stamp/$(basename "$image")"
done

git -C "$work" add -A
git -C "$work" -c user.name="DevSpace QA" -c user.email="qa@devspace.invalid" commit -qm "QA evidence for #${pr}"
git -C "$work" push -q origin "HEAD:refs/heads/${branch}"

for image in "$@"; do
  name="$(basename "$image")"
  echo "![${name}](https://raw.githubusercontent.com/${repo}/${branch}/${stamp}/${name})"
done
