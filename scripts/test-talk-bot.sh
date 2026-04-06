#!/bin/bash
#
# MoltAgent NC Talk Bot Test Script
#
# Tests the webhook server with simulated NC Talk messages.
#
# Usage:
#   ./scripts/test-talk-bot.sh [port] [secret]
#
# Examples:
#   ./scripts/test-talk-bot.sh                    # Uses defaults
#   ./scripts/test-talk-bot.sh 3000 my-secret     # Custom port/secret
#

set -e

# Configuration
PORT="${1:-3000}"
SECRET="${2:-test-secret-for-webhook-testing-must-be-long-enough}"
BACKEND="${NC_URL:-https://YOUR_NEXTCLOUD_URL}"
BASE_URL="http://localhost:${PORT}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           MoltAgent NC Talk Bot Test Script                    ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo -e "Server URL: ${BLUE}${BASE_URL}${NC}"
echo -e "Backend: ${BLUE}${BACKEND}${NC}"
echo ""

# Check if server is running
echo -e "${YELLOW}Checking server...${NC}"
if ! curl -s "${BASE_URL}/health" > /dev/null 2>&1; then
    echo -e "${RED}ERROR: Webhook server is not running!${NC}"
    echo ""
    echo "Start it with:"
    echo "  NC_PASSWORD=test NC_TALK_SECRET=${SECRET} node webhook-server.js"
    echo ""
    exit 1
fi
echo -e "${GREEN}✓ Server is running${NC}"
echo ""

# Function to send signed webhook
send_webhook() {
    local message="$1"
    local user="${2:-testuser}"
    local room="${3:-testroom}"

    # Create payload
    local body=$(cat <<EOF
{
  "type": "Create",
  "actor": {
    "type": "Person",
    "id": "users/${user}",
    "name": "${user}"
  },
  "object": {
    "type": "Note",
    "id": "$(date +%s)",
    "content": "${message}"
  },
  "target": {
    "type": "Collection",
    "id": "${room}",
    "name": "Test Room"
  }
}
EOF
)

    # Generate signature
    local random=$(openssl rand -hex 32)
    local signature=$(echo -n "${random}${body}" | openssl dgst -sha256 -hmac "${SECRET}" | cut -d' ' -f2)

    # Send request
    local response=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/webhook/nctalk" \
        -H "Content-Type: application/json" \
        -H "X-Nextcloud-Talk-Signature: ${signature}" \
        -H "X-Nextcloud-Talk-Random: ${random}" \
        -H "X-Nextcloud-Talk-Backend: ${BACKEND}" \
        -d "${body}")

    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')

    if [ "$status_code" == "200" ]; then
        echo -e "${GREEN}✓${NC} Message sent: ${message}"
        return 0
    else
        echo -e "${RED}✗${NC} Failed (${status_code}): ${body}"
        return 1
    fi
}

# Run tests
echo "═══════════════════════════════════════════════════════════════"
echo "Testing Commands"
echo "═══════════════════════════════════════════════════════════════"

echo ""
echo "1. Testing /help command..."
send_webhook "/help"

echo ""
echo "2. Testing /status command..."
send_webhook "/status"

echo ""
echo "3. Testing /stats command..."
send_webhook "/stats"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Testing Chat Messages"
echo "═══════════════════════════════════════════════════════════════"

echo ""
echo "4. Testing simple message..."
send_webhook "Hello, MoltAgent!"

echo ""
echo "5. Testing from different user..."
send_webhook "Hi from Alice!" "alice"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Testing Security"
echo "═══════════════════════════════════════════════════════════════"

echo ""
echo "6. Testing invalid signature (should fail)..."
# Create payload with wrong signature
body='{"type":"Create","object":{"content":"test"}}'
curl -s -X POST "${BASE_URL}/webhook/nctalk" \
    -H "Content-Type: application/json" \
    -H "X-Nextcloud-Talk-Signature: invalid0000000000000000000000000000000000000000000000000000000000" \
    -H "X-Nextcloud-Talk-Random: $(openssl rand -hex 32)" \
    -H "X-Nextcloud-Talk-Backend: ${BACKEND}" \
    -d "${body}" > /dev/null 2>&1
if [ $? -eq 0 ]; then
    # Check if it was rejected (401)
    status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/webhook/nctalk" \
        -H "Content-Type: application/json" \
        -H "X-Nextcloud-Talk-Signature: invalid0000000000000000000000000000000000000000000000000000000000" \
        -H "X-Nextcloud-Talk-Random: $(openssl rand -hex 32)" \
        -H "X-Nextcloud-Talk-Backend: ${BACKEND}" \
        -d "${body}")
    if [ "$status" == "401" ]; then
        echo -e "${GREEN}✓${NC} Invalid signature correctly rejected (401)"
    else
        echo -e "${RED}✗${NC} Expected 401, got ${status}"
    fi
fi

echo ""
echo "7. Testing wrong backend (should fail)..."
random=$(openssl rand -hex 32)
signature=$(echo -n "${random}${body}" | openssl dgst -sha256 -hmac "${SECRET}" | cut -d' ' -f2)
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/webhook/nctalk" \
    -H "Content-Type: application/json" \
    -H "X-Nextcloud-Talk-Signature: ${signature}" \
    -H "X-Nextcloud-Talk-Random: ${random}" \
    -H "X-Nextcloud-Talk-Backend: https://evil.example.com" \
    -d "${body}")
if [ "$status" == "401" ]; then
    echo -e "${GREEN}✓${NC} Wrong backend correctly rejected (401)"
else
    echo -e "${RED}✗${NC} Expected 401, got ${status}"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Server Stats"
echo "═══════════════════════════════════════════════════════════════"
echo ""
curl -s "${BASE_URL}/stats" | python3 -m json.tool 2>/dev/null || curl -s "${BASE_URL}/stats"

echo ""
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo -e "${GREEN}Tests Complete!${NC}"
echo "═══════════════════════════════════════════════════════════════"
echo ""
