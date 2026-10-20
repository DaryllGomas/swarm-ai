#!/usr/bin/env bash
# Prepare one accepted Town Hall research receipt as a local commit. Never pushes or opens a PR.
set -euo pipefail
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/publish_townhall.py" "$@"
