#!/usr/bin/env bash
# Review Swarm submissions. The admin token is read from ~/.config/swarm-ai/admin-token (never from the repo).
#   review.sh pending                       list submissions waiting for review
#   review.sh accept <id> [note]            accept one
#   review.sh reject <id> [note]            reject one
#   review.sh sync                          pull tasks from Town Hall now
# SWARM_URL overrides the address (default https://swarm.bigpicsolutions.com), e.g. for local dev.
set -euo pipefail
BASE="${SWARM_URL:-https://swarm.bigpicsolutions.com}"
TOKEN_FILE="${SWARM_ADMIN_TOKEN_FILE:-$HOME/.config/swarm-ai/admin-token}"
[ -r "$TOKEN_FILE" ] || { echo "No admin token at $TOKEN_FILE" >&2; exit 1; }
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
call() { curl -sS -H "Authorization: Bearer $TOKEN" "$@"; }
pretty() { if command -v jq >/dev/null; then jq .; else cat; fi; }

case "${1:-}" in
  pending) call "$BASE/api/admin/pending" | pretty ;;
  accept|reject)
    [ -n "${2:-}" ] || { echo "usage: $0 $1 <submission id> [note]" >&2; exit 1; }
    note="${3:-}"
    body=$(printf '{"id":%d,"decision":"%s","note":%s}' "$2" "$1" "$(printf '%s' "$note" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")
    call -X POST -H 'Content-Type: application/json' -d "$body" "$BASE/api/admin/review" | pretty ;;
  sync) call -X POST "$BASE/api/admin/sync" | pretty ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
