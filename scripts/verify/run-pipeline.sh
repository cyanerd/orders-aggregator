#!/usr/bin/env bash
# Порядок из TASK.md: чистая БД -> сервис -> POST /sync -> вебхуки -> daily-totals c_7 за 27-31.03.
# Запуск из корня проекта: scripts/verify/run-pipeline.sh result.json
# ВНИМАНИЕ: docker compose down -v удаляет данные БД этого compose-проекта.
# Любая ошибка — выход с кодом 1 и сообщением; файл результата при ошибке не трогается.
set -uo pipefail
OUT=${1:?usage: run-pipeline.sh <out.json>}
LOG=$(mktemp "${TMPDIR:-/tmp}/orders-aggregator.XXXXXX")
TMP_OUT=$(mktemp "${TMPDIR:-/tmp}/daily-totals.XXXXXX")
SRV=

fail() {
  echo "ERROR: $*" >&2
  echo "server log: $LOG" >&2
  exit 1
}

cleanup() {
  if [ -n "$SRV" ] && kill -0 "$SRV" 2>/dev/null; then
    kill "$SRV" 2>/dev/null
    wait "$SRV" 2>/dev/null
  fi
  rm -f "$TMP_OUT"
}
trap cleanup EXIT

# Иначе запросы уйдут чужому процессу, а наш сервер упадёт с EADDRINUSE
curl -s -o /dev/null -m 2 localhost:3000 && fail "port 3000 is already in use"

out=$(docker compose down -v 2>&1) || fail "docker compose down: $out"
out=$(docker compose up -d 2>&1) || fail "docker compose up: $out"
ready=
for _ in $(seq 1 60); do
  docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1 && ready=1 && break
  sleep 1
done
[ -n "$ready" ] || fail "postgres did not become ready"
sleep 2

# Запускаем tsx напрямую: $SRV — наш процесс, tsx пересылает SIGTERM дочернему node
node_modules/.bin/tsx src/server.ts >"$LOG" 2>&1 &
SRV=$!
up=
for _ in $(seq 1 60); do
  kill -0 "$SRV" 2>/dev/null || fail "service exited during startup"
  curl -sf localhost:3000/health >/dev/null && up=1 && break
  sleep 1
done
[ -n "$up" ] || fail "service did not start"

sync=$(curl -sf -X POST localhost:3000/sync) || fail "POST /sync failed"
echo "sync: $sync"
case "$sync" in *'"invalid":0'*) ;; *) echo "WARNING: sync skipped invalid orders" >&2 ;; esac

wh=$(docker compose run --rm orders-api webhooks --target http://host.docker.internal:3000/webhooks/order 2>&1) ||
  fail "webhooks run failed: $(printf '%s' "$wh" | tail -3)"
wh=$(printf '%s\n' "$wh" | grep 'webhooks sent:') || fail "webhooks: no summary line"
echo "$wh"
# Ожидаем только 200: отправитель завершается с кодом 0, даже если сервис отвечал 4xx/5xx
case "$wh" in *'responses: {"200":'*'}') ;; *) fail "webhooks: not all deliveries got 200" ;; esac
case "$wh" in *'"200":'*','*) fail "webhooks: not all deliveries got 200" ;; esac

curl -sf "localhost:3000/customers/c_7/daily-totals?from=2026-03-27&to=2026-03-31" >"$TMP_OUT" ||
  fail "daily-totals failed"
mv "$TMP_OUT" "$OUT"
cat "$OUT"
echo
