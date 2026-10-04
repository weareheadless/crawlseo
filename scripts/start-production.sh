#!/usr/bin/env bash
set -euo pipefail

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
