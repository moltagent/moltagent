#!/bin/bash
#
# Moltagent Credential Setup Script
#
# This script sets up secure credential storage for Moltagent.
# Run as root or with sudo.
#
# Usage: sudo ./setup-credentials.sh
#

set -e

CREDSTORE_DIR="/etc/credstore"
CREDENTIAL_FILE="$CREDSTORE_DIR/moltagent-nc-password"

echo "========================================"
echo "Moltagent Credential Setup"
echo "========================================"
echo ""

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "Error: This script must be run as root (use sudo)"
   exit 1
fi

# Create credential store directory
echo "[1/5] Creating credential store directory..."
mkdir -p "$CREDSTORE_DIR"
chmod 700 "$CREDSTORE_DIR"
echo "      Created $CREDSTORE_DIR"

# Check if credential already exists
if [[ -f "$CREDENTIAL_FILE" ]]; then
    echo ""
    read -p "Credential file already exists. Overwrite? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing credential."
        exit 0
    fi
fi

# Prompt for password
echo ""
echo "[2/5] Enter the Nextcloud password for the moltagent user."
echo "      This will be stored securely and used to authenticate with NC."
echo ""
read -s -p "Password: " NC_PASSWORD
echo ""

if [[ -z "$NC_PASSWORD" ]]; then
    echo "Error: Password cannot be empty"
    exit 1
fi

# Write credential (no newline)
echo "[3/5] Writing credential to secure store..."
echo -n "$NC_PASSWORD" > "$CREDENTIAL_FILE"
chmod 600 "$CREDENTIAL_FILE"
chown root:root "$CREDENTIAL_FILE"
echo "      Credential stored at $CREDENTIAL_FILE"

# Clear password from memory
NC_PASSWORD=""

# Create moltagent user if doesn't exist
echo ""
echo "[4/5] Checking moltagent system user..."
if id "moltagent" &>/dev/null; then
    echo "      User 'moltagent' already exists"
else
    useradd --system --no-create-home --shell /usr/sbin/nologin moltagent
    echo "      Created system user 'moltagent'"
fi

# Set up log directory
echo ""
echo "[5/5] Setting up directories..."
mkdir -p /opt/moltagent/logs
chown moltagent:moltagent /opt/moltagent/logs
chmod 750 /opt/moltagent/logs
echo "      Created /opt/moltagent/logs"

echo ""
echo "========================================"
echo "Setup Complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo ""
echo "  1. Copy the systemd service file:"
echo "     sudo cp /opt/moltagent/deploy/moltagent.service /etc/systemd/system/"
echo ""
echo "  2. Reload systemd:"
echo "     sudo systemctl daemon-reload"
echo ""
echo "  3. Enable and start the service:"
echo "     sudo systemctl enable moltagent"
echo "     sudo systemctl start moltagent"
echo ""
echo "  4. Check status:"
echo "     sudo systemctl status moltagent"
echo "     journalctl -u moltagent -f"
echo ""
echo "  5. Share moltagent's Personal calendar with the human owner (read access):"
echo "     This lets the owner see agent-created meetings and clean up after demos."
echo ""
echo "     curl -u 'moltagent:<NC_PASSWORD>' -X POST \\"
echo "       'https://<NC_HOST>/remote.php/dav/calendars/moltagent/personal/' \\"
echo "       -H 'Content-Type: application/xml; charset=utf-8' \\"
echo "       -d '<?xml version=\"1.0\" encoding=\"UTF-8\"?>'"
echo "       '<o:share xmlns:o=\"http://owncloud.org/ns\" xmlns:d=\"DAV:\">'"
echo "       '  <o:set><d:href>principal:principals/users/<ADMIN_USER></d:href></o:set>'"
echo "       '</o:share>'"
echo ""
echo "     Replace <NC_HOST>, <NC_PASSWORD>, and <ADMIN_USER> with your values."
echo ""
echo "To update the credential later:"
echo "  sudo ./setup-credentials.sh"
echo ""
