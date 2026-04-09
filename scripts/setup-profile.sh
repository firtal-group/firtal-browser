#!/bin/bash
# Setup a dedicated Chrome profile for Firtal Browser agent
# Usage: ./scripts/setup-profile.sh [profile-name]

set -e

PROFILE_NAME="${1:-firtal-agent}"
PROFILE_DIR="$HOME/.firtal-browser/profiles/$PROFILE_NAME"

echo "Setting up Firtal Browser agent profile: $PROFILE_NAME"
echo "Profile directory: $PROFILE_DIR"

# Detect Chrome binary
if [[ "$OSTYPE" == "darwin"* ]]; then
  CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  CHROME_BIN=$(which google-chrome || which chromium-browser || which chromium 2>/dev/null)
else
  echo "Unsupported OS: $OSTYPE"
  exit 1
fi

if [ ! -f "$CHROME_BIN" ] && [ ! -x "$CHROME_BIN" ]; then
  echo "Chrome not found at: $CHROME_BIN"
  echo "Please install Google Chrome or set CHROME_BIN environment variable"
  exit 1
fi

echo "Chrome binary: $CHROME_BIN"

# Create profile directory
mkdir -p "$PROFILE_DIR"

# Get the extension path (relative to this script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Check if extension is built
EXTENSION_DIR="$REPO_DIR/dist/chrome"
if [ ! -d "$EXTENSION_DIR" ]; then
  echo "Extension not built yet. Building..."
  cd "$REPO_DIR" && npm run build:chrome
  EXTENSION_DIR="$REPO_DIR/dist/chrome"
fi

echo ""
echo "Launching agent Chrome with Firtal Browser extension..."
echo "---"
echo "1. Log into your services (Looker Studio, Shopify, GA4, etc.)"
echo "2. The profile will remember your sessions for future use"
echo "3. Close this window when done — sessions are saved automatically"
echo "---"
echo ""

# Launch Chrome with dedicated profile and extension
"$CHROME_BIN" \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$EXTENSION_DIR" \
  --no-first-run \
  --no-default-browser-check \
  &

CHROME_PID=$!
echo "Agent Chrome launched (PID: $CHROME_PID)"
echo "Profile saved at: $PROFILE_DIR"
echo ""
echo "To relaunch later:"
echo "  $0 $PROFILE_NAME"
