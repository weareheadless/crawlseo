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
