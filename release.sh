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

# 2. Update file, commit, and tag
jq --arg ver "$NEW_VERSION" '.version = $ver' manifest.json > tmp.json && mv tmp.json manifest.json
git add manifest.json
git commit -m "chore: bump version to $NEW_VERSION"
git tag -a "$NEW_VERSION" -m "$NEW_VERSION"

# 3. Push everything to GitHub
git push origin main --tags
