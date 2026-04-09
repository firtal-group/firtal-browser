#!/bin/bash
# Double-click this file to launch Firtal Browser agent Chrome
cd "$(dirname "$0")"
cd server

# First time? Run setup
if [ ! -d "../dist/chrome" ]; then
  npm install --silent 2>/dev/null
  node cli.js setup
else
  node cli.js launch
fi
