#!/usr/bin/env bash
# Build the image and verify it boots with only environment variables.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-back-in-stock-alerts:smoke}"
NAME="${NAME:-bis-smoke}"
PORT="${PORT:-4599}"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build -t "$IMAGE" "$ROOT"
cleanup
docker run -d --name "$NAME" \
  -e PORT="$PORT" \
  -e STOCK_API_URL="http://127.0.0.1:9/api/stock" \
  -e STOCK_API_KEY="smoke" \
  -e RESEND_API_KEY="smoke" \
  -e RESEND_BASE_URL="http://127.0.0.1:9" \
  -e WEBHOOK_SECRET="smoke-secret" \
  -e ADMIN_PASSWORD="smoke-password" \
  -p "$PORT:$PORT" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

curl -fsS "http://127.0.0.1:$PORT/healthz"
echo
curl -fsS -o /dev/null -w "embed.css HTTP %{http_code}\n" "http://127.0.0.1:$PORT/assets/embed.css"
curl -fsS -o /dev/null -w "root HTTP %{http_code}\n" "http://127.0.0.1:$PORT/"
test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/admin")" = "401"
echo "admin without credentials HTTP 401"
echo "docker smoke test passed"
