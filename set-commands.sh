#!/usr/bin/env bash
# Регистрирует список команд в Telegram — после этого у поля ввода в чате
# появляется кнопка "/" с меню, набирать команды руками не нужно.
set -euo pipefail
set -a; . /opt/tg-agent/.env; set +a

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "start", "description": "Начало работы, подсказка по командам"},
      {"command": "ctx", "description": "Список разговоров / переключиться: /ctx имя"},
      {"command": "new", "description": "Забыть историю текущего разговора"},
      {"command": "id", "description": "Показать мой Telegram-идентификатор"}
    ]
  }'
echo
