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

# 2. Check if git working directory is clean
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Error: You have uncommitted changes. Clean your git tree first."
  exit 1
fi

# 3. Use npm version to calculate the new version and update package.json
echo "🔄 Calculating new $RELEASE_TYPE version..."
NEW_VERSION=$(npm version "$RELEASE_TYPE" --no-git-tag-version | sed 's/v//')

# 4. Update manifest.json using jq
if [ -f manifest.json ]; then
  echo "📝 Updating manifest.json to $NEW_VERSION..."
  jq --arg ver "$NEW_VERSION" '.version = $ver' manifest.json > manifest.tmp.json && mv manifest.tmp.json manifest.json
else
  echo "⚠️ Warning: manifest.json not found!"
fi

# 5. Commit the changes
echo "💾 Committing version files..."
git add package.json manifest.json
if [ -f package-lock.json ]; then git add package-lock.json; fi

git commit -m "chore: bump version to $NEW_VERSION"

# 6. Create the tag EXACTLY as Obsidian documentation requests (no "v" prefix, annotated tag)
echo "🏷️ Creating Git tag $NEW_VERSION..."
git tag -a "$NEW_VERSION" -m "$NEW_VERSION"

echo "✅ Success! Run the following to trigger the GitHub Action:"
echo "👉 git push origin main --tags"
