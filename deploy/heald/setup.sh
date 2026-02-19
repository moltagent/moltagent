#!/bin/bash
# MoltAgent Self-Heal Daemon (heald) — Installer
#
# Usage: bash setup.sh
# Run on the Ollama VM as root.

set -euo pipefail

INSTALL_DIR="/opt/heald"
CONFIG_DIR="/etc/heald"
TOKEN_FILE="${CONFIG_DIR}/token"
SERVICE_FILE="/etc/systemd/system/heald.service"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== MoltAgent Self-Heal Daemon Installer ==="
echo ""

# 1. Copy daemon script
echo "[1/5] Installing heald.py → ${INSTALL_DIR}/"
mkdir -p "${INSTALL_DIR}"
cp "${SCRIPT_DIR}/heald.py" "${INSTALL_DIR}/heald.py"
chmod 755 "${INSTALL_DIR}/heald.py"

# 2. Create config directory
echo "[2/5] Creating config directory → ${CONFIG_DIR}/"
mkdir -p "${CONFIG_DIR}"

# 3. Token setup
if [ -f "${TOKEN_FILE}" ]; then
  echo "[3/5] Token file already exists at ${TOKEN_FILE} — keeping it."
else
  echo "[3/5] Setting up bearer token..."
  read -rp "Enter bearer token (leave empty to auto-generate): " USER_TOKEN
  if [ -z "${USER_TOKEN}" ]; then
    USER_TOKEN=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
    echo "     Generated token: ${USER_TOKEN}"
  fi
  echo -n "${USER_TOKEN}" > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
  echo "     Token written to ${TOKEN_FILE}"
fi

# 4. Install systemd unit
echo "[4/5] Installing systemd service..."
cp "${SCRIPT_DIR}/heald.service" "${SERVICE_FILE}"
systemctl daemon-reload

# 5. Enable and start
echo "[5/5] Enabling and starting heald..."
systemctl enable heald
systemctl restart heald

echo ""
echo "=== Done ==="
echo ""
echo "Service status:"
systemctl status heald --no-pager || true
echo ""

# Print token for the user to save
SAVED_TOKEN=$(cat "${TOKEN_FILE}")
echo "================================================"
echo "SAVE THIS TOKEN in NC Passwords as 'heald-token':"
echo ""
echo "  ${SAVED_TOKEN}"
echo ""
echo "================================================"
echo ""
echo "Test: curl http://$(hostname -I | awk '{print $1}'):7867/health"
