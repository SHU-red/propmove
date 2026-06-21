#!/usr/bin/env bash
set -e

# 1. Get current version and do the math
CURRENT_VERSION=$(jq -r '.version' manifest.json)
MAJOR=$(echo "$CURRENT_VERSION" | cut -d. -f1)
MINOR=$(echo "$CURRENT_VERSION" | cut -d. -f2)
PATCH=$(echo "$CURRENT_VERSION" | cut -d. -f3)

if [ "$1" == "major" ]; then
  MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0
elif [ "$1" == "minor" ]; then
  MINOR=$((MINOR + 1)); PATCH=0
else
  PATCH=$((PATCH + 1))
fi
NEW_VERSION="$MAJOR.$MINOR.$PATCH"

# 2. Build categorized changelog from conventional commits
prev_tag=$(git describe --tags --abbrev=0 HEAD 2>/dev/null || true)

features=""
bugfixes=""
maintenance=""

if [ -n "$prev_tag" ]; then
  while IFS= read -r line; do
    # Strip conventional commit prefix: "feat:", "fix:", "chore:", "docs:", etc.
    desc="$(echo "$line" | sed 's/^[a-z]\{1,\}([^)]*): *//i; s/^[a-z]\{1,\}: *//i')"
    [ -z "$desc" ] && continue

    if echo "$line" | grep -qi '^feat'; then
      features="$features  - $desc"$'\n'
    elif echo "$line" | grep -qi '^fix'; then
      bugfixes="$bugfixes  - $desc"$'\n'
    elif echo "$line" | grep -qi '^docs'; then
      features="$features  - $desc"$'\n'
    else
      maintenance="$maintenance  - $desc"$'\n'
    fi
  done < <(git log "$prev_tag..HEAD" --pretty=format:'%s' --no-merges 2>/dev/null || true)
fi

changelog="## v$NEW_VERSION"
[ -n "$features" ]    && changelog="$changelog"$'\n\n'"### ✨ Features"$'\n'"$features"
[ -n "$bugfixes" ]    && changelog="$changelog"$'\n\n'"### 🐛 Bug Fixes"$'\n'"$bugfixes"
[ -n "$maintenance" ] && changelog="$changelog"$'\n\n'"### 🔧 Maintenance"$'\n'"$maintenance"

# 3. Update files, commit, and tag
jq --arg ver "$NEW_VERSION" '.version = $ver' manifest.json > tmp.json && mv tmp.json manifest.json

# Update versions.json with new version
jq --arg ver "$NEW_VERSION" --arg minapp "1.5.0" '. + {($ver): $minapp}' versions.json > tmp.json && mv tmp.json versions.json

git add manifest.json versions.json
git commit -m "chore: bump version to $NEW_VERSION"

# Create annotated tag with structured changelog
git tag -a "$NEW_VERSION" -m "$changelog"

# 4. Push everything to GitHub
# GitHub Actions (release.yml) reads the tag message as release body
git push origin main --tags
