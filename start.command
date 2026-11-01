#!/bin/bash
# Double-click to launch the twin meme templater on this Mac.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it with:  brew install node   (or from https://nodejs.org)"; read -n1 -p "Press any key to close"; exit 1
fi
# Reinstall dependencies if they were installed on a different OS (e.g. by Claude's sandbox).
if [ ! -f node_modules/.mac-installed ]; then
  echo "Installing dependencies for this Mac…"
  rm -rf node_modules && npm install --no-audit --no-fund && touch node_modules/.mac-installed || { read -n1 -p "npm install failed. Press any key"; exit 1; }
fi
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2); PORT=${PORT:-3000}
(sleep 2; open "http://localhost:$PORT") &
npm start
