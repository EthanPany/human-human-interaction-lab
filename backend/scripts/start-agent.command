#!/bin/zsh
# Double click in Finder: runs the iMessage agent on the dedicated Photon
# Spectrum line and restarts it if it stops. Needs SPECTRUM_PROJECT_ID and
# SPECTRUM_PROJECT_SECRET in backend/.env.local, and AGENT_LINE in the Convex env.
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -d node_modules ] || npm install
while true; do
  npm run agent 2>&1 | tee -a agent.log
  echo "Agent stopped, restarting in 5 s" | tee -a agent.log
  sleep 5
done
