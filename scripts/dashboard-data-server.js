#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Moltagent Dashboard Data Server
// ═══════════════════════════════════════════════════════════════
//
// Serves live commit history and status manifest for the dashboard.
// Zero external dependencies — uses Node.js built-in http module.
//
// Usage:
//   node dashboard-data-server.js                    # port 3099
//   PORT=3100 node dashboard-data-server.js          # custom port
//
// Endpoints:
//   GET /api/commits      — git commit history (cached, refreshes on git hook)
//   GET /api/status       — component status manifest
//   GET /api/health       — server health check
//
// Deployment:
//   pm2 start dashboard-data-server.js --name moltagent-dashboard-api
//   (or add to existing systemd service)

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.DASHBOARD_PORT || process.env.PORT || '3099', 10);
const REPO_PATH = process.env.REPO_PATH || '/opt/moltagent';
const DATA_DIR = path.join(REPO_PATH, '.dashboard-cache');
const COMMITS_FILE = path.join(DATA_DIR, 'commits.json');
const STATUS_FILE = path.join(REPO_PATH, 'status-manifest.json');
const DASHBOARD_HTML = path.join(REPO_PATH, 'scripts', 'dashboard.html');
const DASHBOARD_PUBLIC_HTML = path.join(REPO_PATH, 'scripts', 'dashboard-public.html');

// Ensure cache dir exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Commit Generation ────────────────────────────────────────────

function categorize(subject) {
  const s = subject.toLowerCase();
  if (/guard|security|interceptor|prompt.?guard|secrets|egress|path.?guard|hitl|approval.?required/.test(s)) return 'security';
  if (/bullshit|provenance|trust.?gate|myth.?detect/.test(s)) return 'security';
  if (/memory|vector|embed|knowledge|graph|bm25|gap.?detect|rhythm|decay|wiki|collectives/.test(s)) return 'memory';
  if (/session.?persist|session.?summary|session.?lifecycle/.test(s)) return 'memory';
  if (/heartbeat|cockpit|deck|caldav|calendar|talk|webhook|mail|voice|stt|tts/.test(s)) return 'integrations';
  if (/llm|router|budget|cost|provider|circuit|fallback|ollama|model.?card|preset|qwen|phi4|claude|sonnet|opus|token/.test(s)) return 'llm';
  if (/classify|classification|intent|micro.?pipeline|agent.?loop|clarif|reference.?resolv|compound.?intent|deferral/.test(s)) return 'core';
  if (/test|spec|bench|mock|diagnostic/.test(s)) return 'testing';
  if (/skill.?forge|template|workflow/.test(s)) return 'features';
  if (/file|webdav|text.?extract|searxng|search|ocr|tesseract/.test(s)) return 'services';
  if (/fix|bug|patch|hotfix/.test(s)) return 'bugfix';
  if (/refactor|clean|rename|move|strip|slim|tune|wire|audit/.test(s)) return 'refactor';
  if (/doc|readme|comment|brief|soul\.md|plan\.md/.test(s)) return 'docs';
  if (/init|setup|deploy|config|ansible|infra|share|bootstrap/.test(s)) return 'infra';
  if (/time.?pars|validation.?gate|extraction|attendee|label.?discipline/.test(s)) return 'core';
  return 'other';
}

function generateCommits(limit = 0) {
  try {
    const limitArg = limit > 0 ? `-n ${limit}` : '';
    const raw = execSync(
      `git -C "${REPO_PATH}" log --no-merges ${limitArg} --pretty=format:"%H|%h|%an|%aI|%s" --`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );

    const commits = raw.trim().split('\n').filter(Boolean).map(line => {
      const [hash, short, author, date, ...subjectParts] = line.split('|');
      const subject = subjectParts.join('|');

      let stats = '';
      let paths = [];
      try {
        const numstat = execSync(
          `git -C "${REPO_PATH}" diff-tree --no-commit-id --numstat -r ${hash}`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        if (numstat) {
          const lines = numstat.split('\n');
          let added = 0, removed = 0;
          lines.forEach(l => {
            const [a, r] = l.split('\t');
            if (a !== '-') added += parseInt(a) || 0;
            if (r !== '-') removed += parseInt(r) || 0;
          });
          stats = `${lines.length} files, +${added} -${removed}`;
        }
        const nameOnly = execSync(
          `git -C "${REPO_PATH}" diff-tree --no-commit-id --name-only -r ${hash}`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        if (nameOnly) paths = nameOnly.split('\n').slice(0, 15);
      } catch (e) { /* skip stats */ }

      return { hash, short, author, date, subject, stats, category: categorize(subject), paths };
    });

    return commits;
  } catch (e) {
    console.error('[dashboard-api] Failed to generate commits:', e.message);
    return [];
  }
}

function refreshCommits() {
  console.log('[dashboard-api] Refreshing commit cache...');
  const commits = generateCommits();
  fs.writeFileSync(COMMITS_FILE, JSON.stringify(commits, null, 2));
  console.log(`[dashboard-api] Cached ${commits.length} commits`);
  return commits;
}

function getCommits() {
  try {
    if (fs.existsSync(COMMITS_FILE)) {
      return JSON.parse(fs.readFileSync(COMMITS_FILE, 'utf8'));
    }
  } catch (e) { /* regenerate */ }
  return refreshCommits();
}

function getStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
  } catch (e) { /* return default */ }
  return { error: 'status-manifest.json not found', path: STATUS_FILE };
}

// ── HTTP Server ──────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS — allow dashboard from anywhere
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let data;
  let status = 200;

  // Serve dashboard HTML at root — public.moltagent.cloud gets filtered version
  if (route === '/' || route === '/dashboard') {
    const host = req.headers.host || '';
    const htmlFile = host.startsWith('public.') ? DASHBOARD_PUBLIC_HTML : DASHBOARD_HTML;
    try {
      const html = fs.readFileSync(htmlFile, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h1>Dashboard not found</h1><p>' + e.message + '</p>');
    }
    return;
  }

  switch (route) {
    case '/api/commits': {
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      const perPage = parseInt(url.searchParams.get('per_page') || '200', 10);
      const allCommits = getCommits();
      const start = (page - 1) * perPage;
      const slice = allCommits.slice(start, start + perPage);
      data = {
        commits: slice,
        page,
        per_page: perPage,
        total: allCommits.length,
        has_more: start + perPage < allCommits.length,
      };
      break;
    }

    case '/api/status':
      data = getStatus();
      break;

    case '/api/refresh': {
      // Called by git post-commit hook
      const refreshed = refreshCommits();
      data = { refreshed: true, total: refreshed.length, timestamp: new Date().toISOString() };
      break;
    }

    case '/api/health':
      data = {
        server: 'moltagent-dashboard-api',
        uptime: process.uptime(),
        repo: REPO_PATH,
        cacheExists: fs.existsSync(COMMITS_FILE),
        statusExists: fs.existsSync(STATUS_FILE),
        timestamp: new Date().toISOString(),
      };
      break;

    default:
      status = 404;
      data = { error: 'Not found', routes: ['/api/commits', '/api/status', '/api/health', '/api/refresh'] };
  }

  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard-api] Listening on port ${PORT}`);
  console.log(`[dashboard-api] Repo: ${REPO_PATH}`);
  console.log(`[dashboard-api] Dashboard: http://116.202.23.5:${PORT}/`);
  console.log(`[dashboard-api] Endpoints:`);
  console.log(`  GET http://116.202.23.5:${PORT}/api/commits`);
  console.log(`  GET http://116.202.23.5:${PORT}/api/status`);
  console.log(`  GET http://116.202.23.5:${PORT}/api/health`);
  console.log(`  GET http://116.202.23.5:${PORT}/api/refresh`);

  // Initial cache generation (all commits)
  refreshCommits();
});
