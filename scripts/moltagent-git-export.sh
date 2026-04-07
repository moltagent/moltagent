#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Moltagent Git Log Exporter
# ═══════════════════════════════════════════════════════════════
#
# Exports commit history as clean JSON for the Moltagent dashboard.
#
# Usage:
#   bash moltagent-git-export.sh                    # default: /opt/moltagent
#   bash moltagent-git-export.sh /path/to/repo      # custom repo path
#   bash moltagent-git-export.sh /opt/moltagent 50   # limit to 50 commits
#
# Output: JSON array to stdout. Redirect to file:
#   bash moltagent-git-export.sh > commits.json
#
# Then paste commits.json content into the dashboard's COMMIT_DATA.

REPO_PATH="${1:-/opt/moltagent}"
LIMIT="${2:-200}"

cd "$REPO_PATH" 2>/dev/null || { echo '{"error": "Cannot access '"$REPO_PATH"'"}' >&2; exit 1; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo '{"error": "Not a git repository"}' >&2; exit 1; }

# Use node for reliable JSON output (already on the Moltagent VM)
node -e '
const { execSync } = require("child_process");
const limit = parseInt(process.argv[1]) || 200;

const raw = execSync(
  `git log --no-merges -n ${limit} --pretty=format:"%H|%h|%an|%aI|%s" --`,
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
);

const categorize = (subject) => {
  const s = subject.toLowerCase();
  if (/guard|security|interceptor|prompt.?guard|secrets|egress|path.?guard/.test(s)) return "security";
  if (/memory|vector|embed|knowledge|graph|bm25|gap.?detect|rhythm|decay/.test(s)) return "memory";
  if (/heartbeat|cockpit|deck|caldav|calendar|talk|webhook/.test(s)) return "integrations";
  if (/llm|router|budget|cost|provider|circuit|fallback/.test(s)) return "llm";
  if (/test|spec|bench/.test(s)) return "testing";
  if (/skill.?forge|template|workflow/.test(s)) return "features";
  if (/file|webdav|text.?extract|searxng|search/.test(s)) return "services";
  if (/fix|bug|patch|hotfix/.test(s)) return "bugfix";
  if (/refactor|clean|rename|move/.test(s)) return "refactor";
  if (/doc|readme|comment|brief/.test(s)) return "docs";
  if (/init|setup|deploy|config|ansible/.test(s)) return "infra";
  return "other";
};

const commits = raw.trim().split("\n").filter(Boolean).map(line => {
  const [hash, short, author, date, ...subjectParts] = line.split("|");
  const subject = subjectParts.join("|"); // subject might contain |
  
  let stats = "";
  let paths = [];
  try {
    const numstat = execSync(
      `git diff-tree --no-commit-id --numstat -r ${hash}`,
      { encoding: "utf8", timeout: 5000 }
    ).trim();
    if (numstat) {
      const lines = numstat.split("\n");
      let added = 0, removed = 0;
      lines.forEach(l => {
        const [a, r] = l.split("\t");
        if (a !== "-") added += parseInt(a) || 0;
        if (r !== "-") removed += parseInt(r) || 0;
      });
      stats = `${lines.length} files, +${added} -${removed}`;
    }
    
    const nameOnly = execSync(
      `git diff-tree --no-commit-id --name-only -r ${hash}`,
      { encoding: "utf8", timeout: 5000 }
    ).trim();
    if (nameOnly) {
      paths = nameOnly.split("\n").slice(0, 15);
    }
  } catch(e) { /* skip stats for this commit */ }

  return {
    hash,
    short,
    author,
    date,
    subject,
    stats,
    category: categorize(subject),
    paths
  };
});

console.log(JSON.stringify(commits, null, 2));
' "$LIMIT"
