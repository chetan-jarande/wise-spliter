#!/usr/bin/env bash
set -euo pipefail

SUPABASE_DIR="${SUPABASE_DIR:-/home/chetan/projects/my-scripts/setup/dependencies}"

cd "$SUPABASE_DIR"

if npx supabase status >/dev/null 2>&1; then
  echo "[supabase-ensure] Centralized Supabase stack is already running."
  docker exec supabase_db_dependencies psql -U postgres -d postgres -c \
    "CREATE SCHEMA IF NOT EXISTS wise_spliter; GRANT USAGE ON SCHEMA wise_spliter TO anon, authenticated, service_role; NOTIFY pgrst, 'reload schema';" >/dev/null 2>&1 || true
  exit 0
fi

echo "[supabase-ensure] Starting centralized Supabase stack in $SUPABASE_DIR..."

# Background helper: as soon as supabase_db_dependencies is accepting connections
# while restoring from an older volume backup, ensure wise_spliter schema exists
# so supabase_rest_dependencies passes its schema-cache health check immediately.
(
  for _ in $(seq 1 60); do
    if docker inspect -f '{{.State.Running}}' supabase_db_dependencies 2>/dev/null | grep -q true; then
      docker exec supabase_db_dependencies psql -U postgres -d postgres -c \
        "CREATE SCHEMA IF NOT EXISTS wise_spliter; GRANT USAGE ON SCHEMA wise_spliter TO anon, authenticated, service_role; NOTIFY pgrst, 'reload schema';" >/dev/null 2>&1 && break || true
    fi
    sleep 1
  done
) &
HELPER_PID=$!

npx supabase start
wait "$HELPER_PID" 2>/dev/null || true
echo "[supabase-ensure] Centralized Supabase stack is healthy."
