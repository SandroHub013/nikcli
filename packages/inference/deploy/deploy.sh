#!/usr/bin/env bash
#
# Run on the Hetzner server as user `ragu`. Expects:
#   - /opt/ragu-inference/package  (synced from local via rsync)
#   - /opt/ragu-inference/.env     (created by remote-deploy.sh)
#
# Idempotent: rebuilds the image and restarts the service.

set -euo pipefail

APP_DIR="/opt/ragu-inference"
SRC_DIR="$APP_DIR/package"
ENV_FILE="$APP_DIR/.env"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "[deploy] missing $SRC_DIR — sync the package first" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[deploy] missing $ENV_FILE — copy .env first" >&2
  exit 1
fi

cd "$SRC_DIR"

echo "[deploy] building image"
docker build -f deploy/Dockerfile -t ragu-inference:latest .

echo "[deploy] (re)starting service"
docker rm -f ragu-inference >/dev/null 2>&1 || true
docker run -d \
  --name ragu-inference \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file "$ENV_FILE" \
  --memory 512m --cpus 1.0 \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
  --health-cmd "wget -qO- http://127.0.0.1:3000/health || exit 1" \
  --health-interval 30s --health-timeout 5s --health-retries 3 \
  ragu-inference:latest

echo "[deploy] waiting for healthy"
for i in $(seq 1 30); do
  sleep 2
  status=$(docker inspect --format='{{.State.Health.Status}}' ragu-inference 2>/dev/null || echo "starting")
  if [[ "$status" == "healthy" ]]; then
    echo "[deploy] healthy after ${i}x2s"
    docker ps --filter name=ragu-inference --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    exit 0
  fi
done

echo "[deploy] not healthy in 60s — logs:" >&2
docker logs --tail 80 ragu-inference >&2
exit 1
