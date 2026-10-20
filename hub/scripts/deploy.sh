#!/usr/bin/env bash
# Deploy the hub with the scoped Cloudflare token (Workers Scripts, D1, Workers Routes), never the broad login.
#   scripts/deploy.sh                      check the repo, run the tests, apply D1 migrations, deploy the Worker
#   scripts/deploy.sh <wrangler args...>   run any wrangler command with the deploy token (e.g. secret put ADMIN_TOKEN);
#                                          the checks above are skipped, since nothing is being deployed
# Token: $CLOUDFLARE_API_TOKEN, else ~/.config/swarm-ai/cf-deploy-token (Swarm's own scoped token; never another project's).
set -euo pipefail
cd "$(dirname "$0")/.."

token=${CLOUDFLARE_API_TOKEN:-}
for f in "$HOME/.config/swarm-ai/cf-deploy-token"; do
  if [ -z "$token" ] && [ -r "$f" ]; then token=$(tr -d '[:space:]' < "$f"); fi
done
[ -n "$token" ] || { echo "No Cloudflare deploy token: set CLOUDFLARE_API_TOKEN or create ~/.config/swarm-ai/cf-deploy-token" >&2; exit 1; }
export CLOUDFLARE_API_TOKEN=$token CLOUDFLARE_ACCOUNT_ID=20ac9fd1340b29a62bcef596311057a1

if [ $# -gt 0 ]; then exec npx wrangler "$@"; fi

# Live deploys come from a clean, committed main, so what runs is what the repo says.
root=$(git rev-parse --show-toplevel)
if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "Refusing to deploy: uncommitted changes (commit or stash them first):" >&2
  git -C "$root" status --short >&2
  exit 1
fi
branch=$(git -C "$root" rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "Refusing to deploy from '$branch': deploys come from main." >&2
  exit 1
fi

[ -d node_modules ] || npm ci
npm test
# 0001 is idempotent, so the first run on the live DB (which has no d1_migrations record) is harmless.
npx wrangler d1 migrations apply swarm-ai --remote
npx wrangler deploy
