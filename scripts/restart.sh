#!/usr/bin/env bash
# Restart the CrawlSEO stack: dev server + Postgres container
# Usage:
#   ./scripts/restart.sh          # restart everything
#   ./scripts/restart.sh --db     # restart only the database container
#   ./scripts/restart.sh --app    # restart only the Next.js dev server
set -euo pipefail

cd "$(dirname "$0")/.."

DB_CONTAINER="seo-db-1"
DEV_PORT=3001

restart_db() {
  echo "→ Restarting Postgres container ($DB_CONTAINER)..."
  sudo docker restart "$DB_CONTAINER"
  echo "  Waiting for Postgres to accept connections..."
  for i in $(seq 1 30); do
    if sudo docker exec "$DB_CONTAINER" pg_isready -U crawlseo >/dev/null 2>&1; then
      echo "  ✓ Postgres is ready"
      return 0
    fi
    sleep 1
  done
  echo "  ✗ Postgres did not become ready in 30s" >&2
  return 1
}

stop_app() {
  echo "→ Stopping Next.js dev server (port $DEV_PORT)..."
  pkill -9 -f "next dev" 2>/dev/null || true
  fuser -k "$DEV_PORT/tcp" 2>/dev/null || true
  sleep 1
  echo "  ✓ Dev server stopped"
}

start_app() {
  echo "→ Starting Next.js dev server..."
  # Clean Turbopack cache to avoid stale module issues
  rm -rf .next
  nohup npm run dev > /tmp/crawlseo-dev.log 2>&1 &
  echo "  Waiting for dev server on port $DEV_PORT..."
  for i in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:$DEV_PORT/crawlseo/api/health" >/dev/null 2>&1; then
      echo "  ✓ Dev server is ready (http://127.0.0.1:$DEV_PORT)"
      return 0
    fi
    sleep 1
  done
  echo "  ✗ Dev server did not become ready in 40s — check /tmp/crawlseo-dev.log" >&2
  return 1
}

case "${1:-all}" in
  --db)
    restart_db
    ;;
  --app)
    stop_app
    start_app
    ;;
  all|--all)
    restart_db
    stop_app
    start_app
    ;;
  *)
    echo "Usage: $0 [--db|--app|--all]" >&2
    exit 1
    ;;
esac

echo "Done."
