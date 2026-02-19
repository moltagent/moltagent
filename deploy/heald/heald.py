#!/usr/bin/env python3
"""
MoltAgent Self-Heal Daemon (heald)

Minimal HTTP daemon that restarts allowlisted systemd services on request.
Runs on the Ollama VM, controlled by the bot via authenticated API calls.

Endpoints:
  GET  /health            — returns service list (no auth)
  POST /restart/<service> — restarts a systemd service (auth required)

Security:
  - Bearer token read from /etc/heald/token
  - Hardcoded service allowlist (cannot be expanded via API)
"""

import hmac
import json
import subprocess
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

BIND_HOST = '0.0.0.0'
BIND_PORT = 7867
TOKEN_PATH = '/etc/heald/token'
ALLOWED_SERVICES = {'whisper-server', 'ollama'}


def load_token():
    try:
        with open(TOKEN_PATH, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        print(f'[heald] FATAL: Token file not found: {TOKEN_PATH}', file=sys.stderr)
        sys.exit(1)


TOKEN = load_token()


class HealdHandler(BaseHTTPRequestHandler):
    """Request handler for the self-heal daemon."""

    def _send_json(self, code, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_auth(self):
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or not hmac.compare_digest(auth[7:], TOKEN):
            self._send_json(403, {'error': 'Forbidden'})
            return False
        return True

    def do_GET(self):
        if self.path == '/health':
            self._send_json(200, {
                'status': 'ok',
                'services': sorted(ALLOWED_SERVICES)
            })
        else:
            self._send_json(404, {'error': 'Not found'})

    def do_POST(self):
        if not self.path.startswith('/restart/'):
            self._send_json(404, {'error': 'Not found'})
            return

        service = self.path[len('/restart/'):]

        if service not in ALLOWED_SERVICES:
            self._send_json(404, {'error': f'Unknown service: {service}'})
            return

        if not self._check_auth():
            return

        try:
            result = subprocess.run(
                ['systemctl', 'restart', service],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode == 0:
                print(f'[heald] Restarted {service}')
                self._send_json(200, {
                    'ok': True,
                    'service': service,
                    'message': f'{service} restarted successfully'
                })
            else:
                print(f'[heald] Failed to restart {service}: {result.stderr.strip()}')
                self._send_json(500, {
                    'ok': False,
                    'service': service,
                    'error': result.stderr.strip() or 'systemctl restart failed'
                })
        except subprocess.TimeoutExpired:
            self._send_json(500, {
                'ok': False,
                'service': service,
                'error': 'Restart timed out (30s)'
            })
        except Exception as e:
            self._send_json(500, {
                'ok': False,
                'service': service,
                'error': str(e)
            })

    def log_message(self, format, *args):
        """Override to prefix with [heald]."""
        try:
            print(f'[heald] {format % args}')
        except Exception:
            print(f'[heald] {format}')


def main():
    server = HTTPServer((BIND_HOST, BIND_PORT), HealdHandler)
    print(f'[heald] Listening on {BIND_HOST}:{BIND_PORT}')
    print(f'[heald] Allowed services: {", ".join(sorted(ALLOWED_SERVICES))}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[heald] Shutting down')
        server.server_close()


if __name__ == '__main__':
    main()
