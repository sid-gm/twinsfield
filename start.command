#!/bin/bash
# Double-click to launch the twin meme templater on this Mac.
# Works on any Mac: finds Node (Homebrew, nvm, fnm, Volta, asdf, nodejs.org installer),
# reinstalls dependencies when the machine / chip / Node version changes, and keeps the
# window open on errors so you can read them.

cd "$(dirname "$0")" || exit 1
LOG="$PWD/start.log"
fail() { echo; echo "❌ $1"; echo "(details also saved to start.log)"; read -n1 -r -p "Press any key to close…"; exit 1; }
exec > >(tee "$LOG") 2>&1
echo "twin · starting from $PWD  ($(sw_vers -productVersion 2>/dev/null) · $(uname -m))"

# --- 1. Find Node -----------------------------------------------------------
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/share/fnm:$HOME/.fnm:$HOME/.asdf/shims:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if ! command -v node >/dev/null 2>&1 && [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use default >/dev/null 2>&1; fi
if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then eval "$(fnm env)"; fi
if ! command -v node >/dev/null 2>&1; then
  # Last resort: ask the user's login shell where node is.
  NODE_BIN="$(${SHELL:-/bin/zsh} -lic 'command -v node' 2>/dev/null | tail -1)"
  [ -n "$NODE_BIN" ] && export PATH="$(dirname "$NODE_BIN"):$PATH"
fi
command -v node >/dev/null 2>&1 || fail "Node.js not found. Install it:  brew install node   (or https://nodejs.org, LTS)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "node $(node -v) at $(command -v node)"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node $(node -v) is too old: need v20+. Update with:  brew upgrade node"

# --- 2. Dependencies (reinstall if installed on another machine/chip/Node) --
STAMP="$(hostname -s)|$(uname -m)|node$NODE_MAJOR"
if [ ! -f node_modules/.install-stamp ] || [ "$(cat node_modules/.install-stamp)" != "$STAMP" ]; then
  echo "Installing dependencies for this Mac ($STAMP)… (first run takes a minute)"
  rm -rf node_modules
  npm install --no-audit --no-fund || fail "npm install failed (see above). Check your internet connection."
  echo "$STAMP" > node_modules/.install-stamp
fi

# --- 3. Config --------------------------------------------------------------
[ -f .env ] || { cp .env.example .env; echo "⚠️  Created .env from .env.example: add your FAL_KEY to it, then relaunch."; }

# --- 4. Port: use .env PORT, or the next free one ---------------------------
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]"'); PORT=${PORT:-3000}
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  if curl -s "http://localhost:$PORT/api/settings" | grep -q kling_tier; then
    echo "twin is already running on port $PORT: opening it."; open "http://localhost:$PORT"; sleep 1; exit 0
  fi
  echo "Port $PORT is busy, trying $((PORT+1))"; PORT=$((PORT+1))
done
export PORT

# --- 5. Run -----------------------------------------------------------------
(sleep 2; open "http://localhost:$PORT") &
# --watch: restart automatically when server.js or lib/ change (not on data/ writes).
node --watch-path=./server.js --watch-path=./lib server.js || fail "The server stopped with an error (see above)."
