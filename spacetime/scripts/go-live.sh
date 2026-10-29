#!/bin/zsh
# Make SpacetimeDB the only live backend and turn Convex off, in the order that
# never answers a text twice: Convex agent off first, then the SpacetimeDB
# publish (agent on) a few seconds later.
#
# Needs, once on this Mac:
#   curl -sSf https://install.spacetimedb.com | sh && spacetime login   (the identity that owns `hhil`)
#   cd backend && npx convex login                                       (access to small-porpoise-293)
# Secrets come from backend/.env.local and are never printed.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/bin:$PATH"
command -v spacetime >/dev/null || { echo "spacetime CLI missing"; exit 1; }

set -a; source backend/.env.local; set +a

echo "== 1. Convex off: unset Photon keys, deploy crons.ts with no crons"
(cd backend && npx convex env remove PHOTON_API_KEY; npx convex env remove PHOTON_PROJECT_ID; npx convex dev --once)

echo "== 2. Publish SpacetimeDB with its env"
(cd spacetime && npm install --silent && spacetime publish hhil --server maincloud)
spacetime call hhil ensure_jobs --server maincloud

echo "== 3. Photon line backfill for existing users"
spacetime call hhil photon_backfill --server maincloud

echo "== 4. Verify"
curl -sS https://maincloud.spacetimedb.com/v1/database/hhil/route/health; echo
sleep 20
spacetime logs hhil --server maincloud -n 60 2>&1 | tail -60
