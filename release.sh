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

# 3. Update files, commit, and tag
jq --arg ver "$NEW_VERSION" '.version = $ver' manifest.json > tmp.json && mv tmp.json manifest.json

# Update versions.json with new version
jq --arg ver "$NEW_VERSION" --arg minapp "1.5.0" '. + {($ver): $minapp}' versions.json > tmp.json && mv tmp.json versions.json

git add manifest.json versions.json
git commit -m "chore: bump version to $NEW_VERSION"

# Create annotated tag
git tag -a "$NEW_VERSION" -m "$NEW_VERSION"

# 4. Push everything to GitHub
# GitHub Actions (release.yml) generates the release body from git log
git push origin main --tags
