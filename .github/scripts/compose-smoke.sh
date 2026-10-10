#!/usr/bin/env bash
# Compose smoke test: builds Robin Admin from source, starts a layout, completes
# setup, enables Telemetry, ingests a sample with a telemetry:write key, queries
# it back and checks it survives a restart. Tears everything down at the end.
#
#   .github/scripts/compose-smoke.sh base    # self-contained stack
#   .github/scripts/compose-smoke.sh suite   # joins a minimal Robin suite
#
# KEEP=1 leaves the stack running for inspection.
set -uo pipefail
LAYOUT=${1:-base}
cd "$(dirname "$0")/../.."

case "$LAYOUT" in
  base) FILES=(-f docker-compose.yaml -f docker-compose.dev.yaml) ;;
  suite) FILES=(-f docker-compose.yaml -f docker-compose.suite.yaml -f docker-compose.dev.yaml) ;;
  *) echo "Unknown layout: $LAYOUT (base|suite)"; exit 2 ;;
esac
# --env-file /dev/null: ignore a developer .env so local runs match CI.
P=(-p "robin-admin-smoke-$LAYOUT" --env-file /dev/null "${FILES[@]}")
random() { openssl rand -hex "$1"; }
export SESSION_SECRET=$(random 32) ROBIN_ADMIN_ENCRYPTION_KEY=$(random 32) DB_PASSWORD=$(random 16)
export ADMIN_HTTPS_PORT=${ADMIN_HTTPS_PORT:-3443}
export ROBIN_ADMIN_PUBLIC_URL="https://localhost:$ADMIN_HTTPS_PORT"
BASE="https://localhost:$ADMIN_HTTPS_PORT"
CONTAINERS=(suite-admin suite-admin-ui suite-admin-gateway suite-victoriametrics)
JAR=$(mktemp)
EMAIL=smoke-admin@example.test
PASS="Smoke-$(random 12)-Aa1!"
RESULT=0
fail() { echo "FAIL: $*"; RESULT=1; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=($1)(JSON.parse(s));console.log(v??'')}catch{console.log('')}})"; }
api() { curl -sk -b "$JAR" -c "$JAR" "$@"; }

if [ "$LAYOUT" = suite ]; then
  # A minimal stand-in for the Robin suite: its network and the roles Admin uses.
  export SUITE_AGENT_CREDENTIAL=$(random 32) MODULE_PROXY_SECRETS_JSON='{}'
  docker network create suite >/dev/null
  docker run -d --name smoke-suite-postgres --network suite --network-alias postgres-backend \
    -e POSTGRES_DB=robin -e POSTGRES_USER=robin -e "POSTGRES_PASSWORD=$DB_PASSWORD" postgres:18-alpine >/dev/null
  docker run -d --name smoke-suite-redis --network suite --network-alias redis-backend redis:alpine >/dev/null
  for _ in $(seq 1 30); do docker exec smoke-suite-postgres pg_isready -U robin -d robin >/dev/null 2>&1 && break; sleep 2; done
  CONTAINERS+=(suite-admin-agent)
else
  CONTAINERS+=(suite-admin-postgres)
fi

cleanup() {
  [ "${KEEP:-0}" = 1 ] && return
  docker compose "${P[@]}" down -v --remove-orphans >/dev/null 2>&1
  if [ "$LAYOUT" = suite ]; then
    docker rm -f smoke-suite-postgres smoke-suite-redis >/dev/null 2>&1
    docker network rm suite >/dev/null 2>&1
  fi
  rm -f "$JAR"
}
trap cleanup EXIT

wait_healthy() {
  local healthy
  for _ in $(seq 1 90); do
    healthy=$(docker inspect --format '{{.State.Health.Status}}' "${CONTAINERS[@]}" 2>/dev/null | grep -c '^healthy$')
    [ "$healthy" = "${#CONTAINERS[@]}" ] && return 0
    sleep 2
  done
  docker inspect --format '{{.Name}} {{.State.Status}} {{.State.Health.Status}}' "${CONTAINERS[@]}" 2>&1
  docker compose "${P[@]}" logs --tail 50 suite-admin 2>&1
  return 1
}
login() {
  CSRF=$(api -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" "$BASE/api/auth/login" | json 'd=>d.data.csrfToken')
}
query_value() {
  local value
  for _ in $(seq 1 30); do
    value=$(api "$BASE/api/telemetry/query?query=smoke_probe_metric" | json 'd=>d.data.series[0].value')
    [ -n "$value" ] && { echo "$value"; return 0; }
    sleep 3
  done
  return 1
}

echo "== build and start ($LAYOUT)"
docker compose "${P[@]}" build >/dev/null || { echo "FAIL: build"; exit 1; }
docker compose "${P[@]}" up -d >/dev/null 2>&1 || fail "compose up"
wait_healthy || { echo "FAIL: stack not healthy"; exit 1; }

echo "== setup and login"
SETUP=$(docker exec suite-admin cat /tmp/robin-admin-setup-id)
OK=$(api -H 'content-type: application/json' -d "{\"setupId\":\"$SETUP\",\"name\":\"Smoke Admin\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" "$BASE/api/setup" | json 'd=>d.success')
[ "$OK" = true ] || fail "setup"
login; [ -n "$CSRF" ] || fail "login"

echo "== enable Telemetry: the bundled store works with no other configuration"
OK=$(api -X PUT -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -d '{"telemetryEnabled":true}' "$BASE/api/config" | json 'd=>d.success')
[ "$OK" = true ] || fail "enable Telemetry"
STATUS=$(api "$BASE/api/telemetry/status" | json 'd=>d.data.configured && d.data.reachable')
[ "$STATUS" = true ] || fail "store not configured and reachable"

echo "== ingest and query"
KEY=$(api -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -d '{"name":"smoke ingest","role":"viewer","scopes":["telemetry:write"]}' "$BASE/api/api-keys" | json 'd=>d.data.plainText')
CODE=$(curl -sk -o /dev/null -w '%{http_code}' -H "authorization: Bearer $KEY" -H 'content-type: text/plain' \
  --data-binary $'smoke_probe_metric{instance="smoke",job="smoke"} 42\n' "$BASE/api/telemetry/import")
[ "$CODE" = 204 ] || fail "import returned $CODE"
VALUE=$(query_value) || fail "sample not queryable"
[ "${VALUE:-}" = 42 ] || fail "unexpected value ${VALUE:-none}"

echo "== snapshot"
NAME=$(api -X POST -H "x-csrf-token: $CSRF" "$BASE/api/config/telemetry/storage/snapshots" | json 'd=>d.data.name')
[ -n "$NAME" ] || fail "snapshot not created"
[ -n "$NAME" ] && { api -X DELETE -H "x-csrf-token: $CSRF" "$BASE/api/config/telemetry/storage/snapshots/$NAME" | json 'd=>d.success' | grep -q true || fail "snapshot not deleted"; }

if [ "$LAYOUT" = suite ]; then
  echo "== co-located agent checks in"
  for _ in $(seq 1 30); do
    STATE=$(docker exec smoke-suite-postgres psql -U robin -d robin -Atc "select status from fleet_agents where agent_id='suite-admin-agent'" 2>/dev/null)
    [ "$STATE" = online ] && break
    sleep 2
  done
  [ "$STATE" = online ] || fail "suite-admin-agent did not check in (${STATE:-no row})"
fi

echo "== restart keeps data"
docker compose "${P[@]}" down >/dev/null 2>&1
docker compose "${P[@]}" up -d >/dev/null 2>&1
wait_healthy >/dev/null || fail "not healthy after restart"
rm -f "$JAR"; JAR=$(mktemp); login
VALUE=$(query_value) || fail "sample lost after restart"

[ "$RESULT" = 0 ] && echo "SMOKE PASSED ($LAYOUT)" || echo "SMOKE FAILED ($LAYOUT)"
exit $RESULT
