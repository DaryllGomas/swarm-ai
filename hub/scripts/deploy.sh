#!/usr/bin/env bash
# Deploy the hub with the scoped Cloudflare token (Workers Scripts, D1, Workers Routes), never the broad login.
#   scripts/deploy.sh                      the ONE checked route: refuses unless the tree is clean, on the branch main (not detached), the commit is
#                                          exactly the tip of a freshly fetched origin/main of the canonical repository, and origin/main was not
#                                          rewritten; then installs pinned dependencies, runs the tests, applies D1 migrations, deploys the Worker with its commit
#   scripts/deploy.sh <wrangler args...>   maintenance only: an allowlist of commands that deploy no code (secrets, logs, listings, d1 execute and time-travel, kv).
#                                          Anything that could deploy, upload a version, roll back or set the stamped commit is refused here.
# Rolling back: revert on main through a pull request and run the checked route again (roll forward). There is no unchecked rollback.
# Token: $CLOUDFLARE_API_TOKEN, else ~/.config/swarm-ai/cf-deploy-token (Swarm's own scoped token; never another project's).
#
# What this does and does not prove: it makes the deploy the maintainer runs come from public code on origin/main. It cannot prove which bytes
# a Cloudflare Worker is running, and anyone holding the deploy token can bypass this script. /version reports what the operator stamped.
set -euo pipefail
cd "$(dirname "$0")/.."

CANONICAL_REPO='DaryllGomas/swarm-ai'

token=${CLOUDFLARE_API_TOKEN:-}
for f in "$HOME/.config/swarm-ai/cf-deploy-token"; do
  if [ -z "$token" ] && [ -r "$f" ]; then token=$(tr -d '[:space:]' < "$f"); fi
done
[ -n "$token" ] || { echo "No Cloudflare deploy token: set CLOUDFLARE_API_TOKEN or create ~/.config/swarm-ai/cf-deploy-token" >&2; exit 1; }
export CLOUDFLARE_API_TOKEN=$token CLOUDFLARE_ACCOUNT_ID=20ac9fd1340b29a62bcef596311057a1

if [ $# -gt 0 ]; then
  # Maintenance passthrough: an ALLOWLIST. A command that is not listed is refused, whatever its name suggests.
  case "$*" in
    *GIT_COMMIT*|*BUILT_AT*) echo "Refusing: the stamped commit and build time are set only by the checked deploy route." >&2; exit 1 ;;
  esac
  case "$1 ${2:-} ${3:-}" in
    "secret put "*|"secret delete "*|"secret list "*|"secret bulk "*) ;;
    "whoami "*|"tail "*|"deployments list"*|"deployments status"*|"versions list"*|"versions view"*) ;;
    "d1 list"*|"d1 info"*|"d1 migrations list"*|"d1 execute"*|"d1 time-travel"*|"kv namespace"*|"kv key"*) ;; # database and key-value work that deploys no code
    *) echo "Refusing 'wrangler $*': not on the maintenance allowlist. Deploys, version uploads, rollbacks and migrations go through the checked route (run this script with no arguments)." >&2; exit 1 ;;
  esac
  exec npx wrangler "$@"
fi

# Live deploys come from a clean, committed main that is the tip of the public repository, so what runs is what the repo says.
root=$(git rev-parse --show-toplevel)
if [ -n "$(git -C "$root" status --porcelain --untracked-files=all)" ]; then
  echo "Refusing to deploy: uncommitted changes (commit or stash them first):" >&2
  git -C "$root" status --short >&2
  exit 1
fi
if ! ref=$(git -C "$root" symbolic-ref -q HEAD); then
  echo "Refusing to deploy a detached HEAD: deploys come from the branch main." >&2
  exit 1
fi
if [ "$ref" != "refs/heads/main" ]; then
  echo "Refusing to deploy from '${ref#refs/heads/}': deploys come from main." >&2
  exit 1
fi

# The remote must be the canonical public repository. (SWARM_DEPLOY_ALLOW_ORIGIN exists for the test suite, which uses a local remote; it is printed
# when used. It does not make anything more trustworthy: anyone who can set it can also edit this script.)
origin_url=$(git -C "$root" remote get-url origin 2>/dev/null || true)
case "$origin_url" in
  "https://github.com/$CANONICAL_REPO"|"https://github.com/$CANONICAL_REPO.git"|"git@github.com:$CANONICAL_REPO.git"|"git@github.com:$CANONICAL_REPO") ;;
  *)
    if [ -n "${SWARM_DEPLOY_ALLOW_ORIGIN:-}" ] && [ "$origin_url" = "$SWARM_DEPLOY_ALLOW_ORIGIN" ]; then
      echo "WARNING: deploying against a non-canonical origin ($origin_url) because SWARM_DEPLOY_ALLOW_ORIGIN says so." >&2
    else
      echo "Refusing to deploy: origin is '$origin_url', not the public repository github.com/$CANONICAL_REPO." >&2
      exit 1
    fi ;;
esac

# Fetch first: a stale remote-tracking branch must not make an unpublished commit look published. Remember where origin/main was, so a
# history rewrite (a force push, or a moved ref) is noticed instead of silently followed.
before=$(git -C "$root" rev-parse -q --verify refs/remotes/origin/main || true)
git -C "$root" fetch --quiet origin main || { echo "Refusing to deploy: could not fetch origin/main to check the commit." >&2; exit 1; }
tip=$(git -C "$root" rev-parse -q --verify FETCH_HEAD) || { echo "Refusing to deploy: could not read the fetched origin/main." >&2; exit 1; }
commit=$(git -C "$root" rev-parse HEAD)
if [ -n "$before" ] && ! git -C "$root" merge-base --is-ancestor "$before" "$tip"; then
  echo "Refusing to deploy: origin/main was rewritten (the previously known tip $before is not an ancestor of $tip). Investigate before deploying." >&2
  exit 1
fi
if [ "$commit" != "$tip" ]; then
  echo "Refusing to deploy $commit: it is not on origin/main as its current tip ($tip). Push it through a pull request, or update main, first." >&2
  exit 1
fi

npm ci
npm test
# The tests and the install must not have changed the tree or moved HEAD.
if [ -n "$(git -C "$root" status --porcelain --untracked-files=all)" ] || [ "$(git -C "$root" rev-parse HEAD)" != "$commit" ]; then
  echo "Refusing to deploy: the working tree or HEAD changed while installing or testing." >&2
  exit 1
fi
# 0001 is idempotent, so the first run on the live DB (which has no d1_migrations record) is harmless.
npx wrangler d1 migrations apply swarm-ai --remote
# GET /version reports these (as the operator-stamped revision, not proof), and the site footer links the commit on GitHub.
npx wrangler deploy --var "GIT_COMMIT:$commit" --var "BUILT_AT:$(date -u +%Y-%m-%dT%H:%M:%SZ)"
