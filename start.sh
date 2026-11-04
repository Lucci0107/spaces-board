#!/bin/bash
# .env があれば読み込んで起動（なければデモモード）
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
exec node server.js
