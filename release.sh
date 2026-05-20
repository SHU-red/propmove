#!/usr/bin/env bash

# Exit immediately if any command fails
set -e

# 1. Accept release type (patch, minor, major)
RELEASE_TYPE=$1

if [[ ! "$RELEASE_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "❌ Error: Please specify release type: patch, minor, or major"
  echo "👉 Example: ./release.sh patch"
  exit 1
fi

# 2. Check if jq is installed
if ! command -v jq &> /dev/null; then
  echo "❌ Error: 'jq' is required but not installed."
  echo "👉 Fix it by running: sudo dnf install jq"
  exit 1
fi

# 3. Check if git working directory is clean
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Error: You have uncommitted changes. Clean your git tree first."
  exit 1
fi

# 4. Read current version from manifest.json
if [ ! -f manifest.json ]; then
  echo "❌ Error: manifest.json not found in this directory!"
  exit 1
fi

CURRENT_VERSION=$(jq -r '.version' manifest.json)

# Double check we didn't get an empty string or the broken raw dots
if [[ -z "$CURRENT_VERSION" || "$CURRENT_VERSION" == "..1" ]]; then
  echo "❌ Error: manifest.json version is empty or invalid ('$CURRENT_VERSION')."
  echo "👉 Please manually open manifest.json and set \"version\": \"1.0.0\" (or your true current version) first."
  exit 1
fi

echo "🔍 Current version is: $CURRENT_VERSION"

# 5. Extract version components cleanly using parameter expansion
MAJOR=$(echo "$CURRENT_VERSION" | cut -d. -f1)
MINOR=$(echo "$CURRENT_VERSION" | cut -d. -f2)
PATCH=$(echo "$CURRENT_VERSION" | cut -d. -f3)

# 6. Calculate new version based on input
if [ "$RELEASE_TYPE" == "major" ]; then
  MAJOR=$((MAJOR + 1))
  MINOR=0
  PATCH=0
elif [ "$RELEASE_TYPE" == "minor" ]; then
  MINOR=$((MINOR + 1))
  PATCH=0
elif [ "$RELEASE_TYPE" == "patch" ]; then
  PATCH=$((PATCH + 1))
fi

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "🔄 Calculated new version: $NEW_VERSION"

# 7. Update manifest.json safely using jq
echo "📝 Updating manifest.json to $NEW_VERSION..."
jq --arg ver "$NEW_VERSION" '.version = $ver' manifest.json > manifest.tmp.json && mv manifest.tmp.json manifest.json

# 8. Commit the changes
echo "💾 Committing manifest.json..."
git add manifest.json
git commit -m "chore: bump version to $NEW_VERSION"

# 9. Create the tag EXACTLY as Obsidian documentation requests
echo "🏷️ Creating Git tag $NEW_VERSION..."
git tag -a "$NEW_VERSION" -m "$NEW_VERSION"

echo "✅ Success! Run the following to trigger your GitHub Action:"
echo "👉 git push origin main --tags"
