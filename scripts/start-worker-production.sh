#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CRAWLSEO_WORKER_RELEASE_DIR:-}" || -z "${CRAWLSEO_WORKER_EXPECTED_SHA:-}" ]]; then
  echo "CRAWLSEO_WORKER_RELEASE_DIR and CRAWLSEO_WORKER_EXPECTED_SHA are required; refusing mutable checkout" >&2
  exit 1
fi
release_dir="$(readlink -f -- "$CRAWLSEO_WORKER_RELEASE_DIR")" || { echo "Configured worker release does not resolve" >&2; exit 1; }
node "$release_dir/scripts/check-worker-release.mjs"
cd "$release_dir"
for env_file in .env.local .env; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    break
  fi
done
for env_file in .env.local .env; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    break
  fi
done

if [[ "${1:-}" == "--smoke" ]]; then
  exec node_modules/.bin/tsx scripts/smoke-worker-release.ts
fi
exec node_modules/.bin/tsx scripts/job-worker.ts
