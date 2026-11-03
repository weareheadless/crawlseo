#!/usr/bin/env bash
set -euo pipefail

if [[ ${CRAWLSEO_WEB_RELEASE_DIR+x} ]]; then
  if [[ -z "$CRAWLSEO_WEB_RELEASE_DIR" ]]; then
    echo "CRAWLSEO_WEB_RELEASE_DIR is set but empty" >&2
    exit 1
  fi

  release_dir="$(readlink -f -- "$CRAWLSEO_WEB_RELEASE_DIR")" || {
    echo "Configured CrawlSEO web release does not resolve" >&2
    exit 1
  }
  if [[ ! -d "$release_dir" || ! -f "$release_dir/server.js" || ! -f "$release_dir/.next/BUILD_ID" ]]; then
    echo "Configured CrawlSEO web release is incomplete" >&2
    exit 1
  fi

  cd "$release_dir"
  # The release carries its own .env. Source it so server-side code sees the same
  # configuration the worker does — without this, a flag like
  # CRAWLSEO_LEGACY_FUNNEL_FREEZE was set in .env but never reached the process.
  for env_file in .env.local .env; do
    if [ -f "$env_file" ]; then
      set -a
      # shellcheck disable=SC1090
      source "$env_file"
      set +a
      break
    fi
  done
  exec node server.js
fi

# Backwards-compatible path for deployments that have not adopted release slots.
cd "$(dirname "$0")/.."

# Next's standalone server does not include these directories automatically.
rm -rf .next/standalone/.next/static .next/standalone/public
cp -a .next/static .next/standalone/.next/static
cp -a public .next/standalone/public

# The standalone build carries .env, but production credentials live in .env.local.
if [ -f .env.local ]; then
  cp .env.local .next/standalone/.env
fi

exec node .next/standalone/server.js
