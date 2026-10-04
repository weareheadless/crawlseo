#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
for env_file in .env.local .env; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    break
  fi
done

exec node_modules/.bin/tsx mcp/http-server.ts
