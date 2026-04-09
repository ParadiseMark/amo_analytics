#!/bin/bash
# deploy.sh — собирает образы локально, пушит в GHCR, деплоит на сервер
# Использование:
#   export GITHUB_TOKEN=ghp_xxxxxx
#   ./scripts/deploy.sh           # собрать и задеплоить backend + frontend
#   ./scripts/deploy.sh backend   # только backend
#   ./scripts/deploy.sh frontend  # только frontend
set -e

REGISTRY="ghcr.io/paradisemark/amo-analytics"
SERVER="root@37.27.253.42"
DEPLOY_PATH="/opt/amo_analytics"
API_URL="https://api.37-27-253-42.nip.io"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
log() { echo -e "${BLUE}[deploy]${NC} $1"; }
ok()  { echo -e "${GREEN}[ok]${NC} $1"; }

TARGET=${1:-all}

# Проверяем токен
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "Ошибка: GITHUB_TOKEN не задан"
  echo "Запусти: export GITHUB_TOKEN=ghp_xxxxxx"
  exit 1
fi

# Логин в GHCR
echo "$GITHUB_TOKEN" | docker login ghcr.io -u ParadiseMark --password-stdin
ok "Logged into ghcr.io"

build_backend() {
  log "Building backend..."
  docker build -f Dockerfile.backend -t "$REGISTRY/backend:latest" .
  docker push "$REGISTRY/backend:latest"
  ok "Backend pushed to GHCR"
}

build_frontend() {
  log "Building frontend..."
  docker build \
    -f frontend/Dockerfile.frontend \
    --build-arg NEXT_PUBLIC_API_URL="$API_URL" \
    -t "$REGISTRY/frontend:latest" \
    ./frontend
  docker push "$REGISTRY/frontend:latest"
  ok "Frontend pushed to GHCR"
}

deploy_server() {
  log "Pulling and restarting on server..."
  ssh "$SERVER" bash << ENDSSH
    set -e
    echo "$GITHUB_TOKEN" | docker login ghcr.io -u ParadiseMark --password-stdin 2>/dev/null
    docker pull $REGISTRY/backend:latest
    docker pull $REGISTRY/frontend:latest

    cd $DEPLOY_PATH
    # Обновляем docker-compose чтобы использовать образы из GHCR
    docker compose up -d --force-recreate backend frontend
    sleep 20
    docker ps --format "{{.Names}} {{.Status}}" | grep amo_
ENDSSH
  ok "Deploy complete!"
}

case "$TARGET" in
  backend)  build_backend;  deploy_server ;;
  frontend) build_frontend; deploy_server ;;
  all)      build_backend; build_frontend; deploy_server ;;
  *)        echo "Usage: $0 [backend|frontend|all]"; exit 1 ;;
esac
