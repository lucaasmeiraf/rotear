#!/bin/sh
# Aplica as migrações pendentes e sobe a API. Argumentos extras vão para o uvicorn (ex.: --reload).
set -e
alembic upgrade head
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 \
  --proxy-headers --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}" "$@"
