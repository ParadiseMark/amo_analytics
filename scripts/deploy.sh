#!/usr/bin/env bash
# deploy.sh — полный деплой на Hetzner VPS
# Использование: ./scripts/deploy.sh yourdomain.com
set -euo pipefail

DOMAIN="${1:?Передай домен: ./scripts/deploy.sh yourdomain.com}"

echo "==> Деплой AMO Analytics на домен: $DOMAIN"

# ─── 1. Подставляем домен в nginx.conf ─────────────────────────────────────────
sed -i "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" nginx/nginx.conf
echo "    nginx.conf обновлён для $DOMAIN"

# ─── 2. Первый запуск: получаем сертификат Let's Encrypt ───────────────────────
echo "==> Получение SSL-сертификата..."
docker compose --profile certbot run --rm certbot
echo "    Сертификат получен"

# ─── 3. Генерируем Drizzle миграции (нужна БД доступна через DIRECT_DATABASE_URL)
echo "==> Применение миграций к Supabase..."
docker compose run --rm --no-deps backend node dist/lib/db/migrate.js
echo "    Миграции применены"

# ─── 4. Поднимаем стек ─────────────────────────────────────────────────────────
echo "==> Запуск docker compose..."
docker compose up -d --build

echo ""
echo "✓ Деплой завершён!"
echo "  Frontend: https://$DOMAIN"
echo "  API:      https://api.$DOMAIN"
echo "  Health:   https://api.$DOMAIN/health"
