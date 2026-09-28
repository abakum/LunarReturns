#!/usr/bin/env bash
# Установка/обновление системного сервиса lunarreturns (VK-бот юбилеев).
# Идемпотентен: повторный запуск обновляет юнит и перезапускает сервис.
# Работает с любым клоном репо: путь к репо и node подставляются из окружения.
#
# Сервис изолирован от пользователя-установщика: DynamicUser без логина,
# база в /var/lib/lunarreturns, токен в /etc/lunarreturns/.env.
#
#   sudo ./lunarreturns-install.sh [путь-к-node]
#
# Без аргумента node ищется как у текущего пользователя (nvm), иначе /usr/bin/node.
set -euo pipefail

cd "$(dirname "$0")"
DIR=$(pwd)
TEMPLATE=lunarreturns.service.in
UNIT=lunarreturns.service
TARGET=/etc/systemd/system/$UNIT
CFG=/etc/lunarreturns
ENV_FILE="$CFG/.env"
RUN_USER=${SUDO_USER:-$USER}
HOME_DIR=$(getent passwd "$RUN_USER" | cut -d: -f6)

# 1. токен
if [ "$(id -u)" -ne 0 ]; then
    echo "нужен root: запустите sudo $0 $*" >&2
    exit 1
fi
install -d -m 700 "$CFG"
if [ ! -s "$ENV_FILE" ] || ! grep -q '^VK_TOKEN=' "$ENV_FILE"; then
    printf 'VK_TOKEN=' > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "Впишите групповой токен в $ENV_FILE (VK_TOKEN=vk1.a....) и запустите скрипт снова."
    ${VISUAL:-${EDITOR:-nano}} "$ENV_FILE" || true
    grep -q '^VK_TOKEN=vk1' "$ENV_FILE" || { echo "токен не задан — отмена"; exit 1; }
fi
chmod 600 "$ENV_FILE"

# 2. путь к node
NODE_BIN=${1:-}
if [ -z "$NODE_BIN" ]; then
    NODE_BIN=$(command -v node || true)
    if [ -z "$NODE_BIN" ] && [ -d "$HOME_DIR/.nvm/versions/node" ]; then
        NODE_BIN="$HOME_DIR/.nvm/versions/node/$(ls "$HOME_DIR/.nvm/versions/node" | sort -V | tail -1)/bin/node"
    fi
fi
[ -x "$NODE_BIN" ] || { echo "node не найден, укажите: $0 /путь/к/node"; exit 1; }
echo "node: $NODE_BIN"

# 3. миграция старой базы из корня репо (если была и перенос ещё не делался)
install -d -m 700 /var/lib/lunarreturns
if [ -f "$DIR/db.json" ] && [ ! -f /var/lib/lunarreturns/db.json ]; then
    install -m 600 "$DIR/db.json" /var/lib/lunarreturns/db.json
    echo "база перенесена: $DIR/db.json -> /var/lib/lunarreturns/db.json"
fi

# 4. юнит из шаблона (пути, node)
sed -e "s|@DIR@|$DIR|g" \
    -e "s|@NODE@|$NODE_BIN|g" \
    -e "s|@CFG@|$CFG|g" \
    "$TEMPLATE" > "$TARGET"

# 5. установка и запуск
systemctl daemon-reload
systemctl enable --now $UNIT 2>/dev/null || systemctl restart $UNIT

sleep 2
systemctl --no-pager --lines 5 status $UNIT || true
echo
echo "Логи:      journalctl -u $UNIT -f"
echo "База:      /var/lib/lunarreturns/db.json"
echo "Токен:     $ENV_FILE"
echo "Остановка: sudo systemctl disable --now $UNIT"
