# MoltAgent Phase 1, Session 1: Security Guards
## Claude Code Implementation Brief

**Date:** 2026-02-05
**Author:** Fu + Claude Opus (architecture)
**Executor:** Claude Code
**Estimated CCode time:** ~2.5 hours
**Dependencies:** None — these are pure modules with zero NC runtime dependencies

---

## Context

MoltAgent is a sovereign AI security layer using Nextcloud as identity/permission system. You are building the first three security guards — pure JavaScript modules that detect and neutralize threats in agent I/O. These guards have **zero external npm dependencies** (Node.js `crypto` only) and **zero coupling** to Nextcloud at runtime. They are imported and used by other modules.

**Read before you start:**
- The existing ESLint config (follow it — the project just passed a full lint sweep)
- The existing test patterns in `test/` (100 tests were just added — match the style)
- The JSDoc conventions already in the codebase

**AGPL-3.0 license header for every new file:**

```javascript
/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */
```

---

## Deliverables (in build order)

| # | File | Est. Time | What It Does |
|---|------|-----------|-------------|
| 1 | `src/security/guards/secrets-guard.js` | 45 min | Detect and redact credentials in any text |
| 2 | `test/guards/secrets-guard.test.js` | 20 min | Pattern coverage + false positive resistance |
| 3 | `src/security/guards/tool-guard.js` | 30 min | Classify operations as FORBIDDEN / APPROVAL_REQUIRED / ROUTE_LOCAL / ALLOWED |
| 4 | `test/guards/tool-guard.test.js` | 15 min | All categories + edge cases |
| 5 | `src/security/response-wrapper.js` | 30 min | Single enforcement point for ALL outgoing text |
| 6 | `test/security/response-wrapper.test.js` | 15 min | Integration with SecretsGuard + suspicious pattern detection |
| 7 | `src/security/index.js` | 5 min | Module exports |
| 8 | Performance benchmark (inline in test) | 10 min | Verify < 0.05ms per guard check |

---

## 1. SecretsGuard

**File:** `src/security/guards/secrets-guard.js`
**Priority:** CRITICAL — build first
**Dependencies:** Node.js `crypto` only

### Purpose

Detects credentials in text (both inputs AND outputs). Redacts them. Returns structured findings. This is the single most important security module — it prevents credential leakage in LLM responses.

### Detection Patterns

Implement these patterns. Each has a name, regex, and severity level:

```javascript
const PATTERNS = [
  // Cloud provider keys
  { name: 'aws_access_key',    pattern: /AKIA[0-9A-Z]{16}/g,                                    severity: 'CRITICAL' },
  { name: 'aws_secret_key',    pattern: /(?:aws_secret|secret_access_key)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi, severity: 'CRITICAL' },

  // API keys with known prefixes
  { name: 'github_token',      pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/g,                      severity: 'CRITICAL' },
  { name: 'github_fine',       pattern: /github_pat_[A-Za-z0-9_]{22,255}/g,                     severity: 'CRITICAL' },
  { name: 'openai_key',        pattern: /sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}/g,        severity: 'CRITICAL' },
  { name: 'anthropic_key',     pattern: /sk-ant-[A-Za-z0-9\-]{20,}/g,                           severity: 'CRITICAL' },
  { name: 'stripe_key',        pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/g,            severity: 'CRITICAL' },
  { name: 'slack_token',       pattern: /xox[bpras]-[A-Za-z0-9\-]{10,}/g,                       severity: 'HIGH' },
  { name: 'slack_webhook',     pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g, severity: 'HIGH' },

  // Private keys (multiline — check for header)
  { name: 'private_key',       pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, severity: 'CRITICAL' },
  { name: 'certificate',       pattern: /-----BEGIN CERTIFICATE-----/g,                          severity: 'MEDIUM' },

  // Database connection strings
  { name: 'db_connection',     pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^:]+:[^@]+@[^\s]+/gi, severity: 'CRITICAL' },

  // Generic high-entropy secrets
  { name: 'password_field',    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi,    severity: 'MEDIUM' },
  { name: 'api_key_field',     pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[^\s'"]{16,}['"]?/gi,   severity: 'HIGH' },
  { name: 'secret_field',      pattern: /(?:secret|token)\s*[:=]\s*['"]?[^\s'"]{16,}['"]?/gi,         severity: 'HIGH' },
  { name: 'bearer_token',      pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,                           severity: 'HIGH' },
  { name: 'basic_auth',        pattern: /Basic\s+[A-Za-z0-9+/]{20,}={0,2}/g,                         severity: 'HIGH' },

  // URL-embedded credentials
  { name: 'url_credentials',   pattern: /https?:\/\/[^:]+:[^@]+@[^\s]+/gi,                           severity: 'CRITICAL' },

  // Nextcloud app passwords (our own system — extra important)
  { name: 'nc_app_password',   pattern: /[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}/g, severity: 'CRITICAL' },
];
```

### Interface

```javascript
class SecretsGuard {
  /**
   * @param {Object} options
   * @param {Array} [options.customPatterns] - Additional patterns [{name, pattern, severity}]
   * @param {string} [options.redactWith='[REDACTED]'] - Replacement string
   */
  constructor(options = {})

  /**
   * Full scan — detect and redact all secrets in content.
   * @param {string} content - Text to scan
   * @returns {{
   *   hasSecrets: boolean,
   *   findings: Array<{type: string, severity: string, preview: string}>,
   *   sanitized: string,
   *   criticalCount: number
   * }}
   * NOTE: preview shows first 4 + last 4 chars only (e.g., "AKIA...XY9Z")
   */
  scan(content)

  /**
   * Fast path — just returns true/false, no redaction.
   * Use for quick pre-checks before expensive operations.
   * @param {string} content
   * @returns {boolean}
   */
  quickCheck(content)

  /**
   * Compute SHA-256 hash of content (for change detection in memory scanning).
   * @param {string} content
   * @returns {string} hex-encoded hash
   */
  hash(content)
}
```

### Implementation Notes

- **Preview generation:** For each finding, show only first 4 and last 4 characters. Example: `AKIAIOSFODNN7EXAMPLE` → `"AKIA...MPLE"`. Never log the full secret.
- **Redaction:** Replace matched text with `[REDACTED:{type}]` so downstream code knows *what* was redacted. Example: `[REDACTED:aws_access_key]`
- **Regex safety:** Clone each regex before use (reset `lastIndex`), or create new instances per scan. Stateful regexes with `/g` flag share state across calls otherwise.
- **criticalCount:** Count of findings with severity `CRITICAL`. This is used by ResponseWrapper to decide whether to block vs. warn.
- **Performance:** Target < 0.05ms for `quickCheck` on typical LLM responses (~500 tokens / ~2000 chars). The `scan` method can be slightly slower since it does redaction.

### Test Cases for SecretsGuard

**Must detect (true positives):**

```javascript
// AWS
'My key is AKIAIOSFODNN7EXAMPLE'
'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'

// GitHub
'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234'
'github_pat_11ABCDEFG_abcdefghijklmnop'

// API keys
'sk-ant-api03-abc123def456ghi789jkl012mno345'
'sk_live_51ABC123def456GHI789jklMNOpqrSTUvwxYZ'
'xoxb-123456789012-1234567890123-AbCdEfGhIjKl'

// Private keys
'-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...'

// Database URIs
'mongodb://admin:sup3rs3cret@db.example.com:27017/mydb'
'postgres://user:p@ssw0rd@localhost:5432/app'

// URL-embedded auth
'https://user:password123@api.example.com/v1/data'

// Generic fields
'password = "MyS3cretP@ss!"'
'api_key: "abcdef1234567890abcdef"'
'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWI...'

// NC app passwords
'Login with yH7kN-rT2mQ-bX9fL-wK4pD-nJ6vS'
```

**Must NOT detect (false positive resistance):**

```javascript
// Normal conversation
'The password policy requires 8 characters'
'I need to update my API key rotation schedule'
'The secret to good pasta is fresh ingredients'
'My token of appreciation for your help'
'The bearer of bad news arrived early'

// Technical content that looks credential-like but isn't
'SHA-256 hash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
'UUID: 550e8400-e29b-41d4-a716-446655440000'
'The function returns a Base64-encoded string'

// Short values that shouldn't trigger
'password = "short"'  // < 8 chars, skip
'key = "abc"'         // < 16 chars, skip
```

**Redaction correctness:**

```javascript
// Input:  'Connect to mongodb://admin:hunter2@db.prod.internal:27017/app'
// Output: 'Connect to [REDACTED:db_connection]'
// Finding: { type: 'db_connection', severity: 'CRITICAL', preview: 'mong...l/app' }
```

---

## 2. ToolGuard

**File:** `src/security/guards/tool-guard.js`
**Priority:** CRITICAL — build second
**Dependencies:** None

### Purpose

Classifies operations into four security levels. This is the "soul-evil prevention layer" — it stops the agent from self-modifying, exfiltrating data, or performing dangerous operations without human approval.

### Operation Categories

These lists are **hardcoded constants**. They are never modifiable at runtime by the agent.

```javascript
const FORBIDDEN = [
  // Self-modification (prevents "soul-evil" attacks)
  'modify_system_prompt', 'modify_soul', 'replace_instructions',
  'modify_config', 'enable_hook', 'disable_sandbox', 'disable_guard',
  'bypass_security', 'modify_permissions', 'elevate_privileges',

  // Marketplace/plugin attacks
  'install_skill', 'install_plugin',

  // Evidence destruction
  'delete_logs', 'modify_audit', 'clear_history',

  // Cross-session attacks
  'access_other_session', 'export_credentials',
];

const REQUIRES_APPROVAL = [
  // External communication (data could leave the system)
  'send_email', 'send_message_external', 'webhook_call',

  // Destructive file operations
  'delete_file', 'delete_files', 'delete_folder',

  // Calendar/contact modification (affects user's real schedule)
  'modify_calendar', 'delete_calendar_event', 'modify_contacts',

  // System-level operations
  'execute_shell', 'run_command',

  // Credential access (first-time per session)
  'access_new_credential',

  // External API calls (potential exfiltration vector)
  'external_api_call',
];

const LOCAL_LLM_ONLY = [
  // Operations where credentials are in the context
  'process_credential', 'process_untrusted_file',

  // Operations with potentially sensitive content
  'process_email_content', 'process_web_content',
  'process_user_upload',

  // Memory operations (injection risk if sent to external LLM)
  'update_memory',

  // PII processing
  'process_pii',
];
```

### Interface

```javascript
class ToolGuard {
  /**
   * @param {Object} options
   * @param {string[]} [options.additionalForbidden] - Extra forbidden operations
   * @param {string[]} [options.additionalApproval] - Extra approval-required operations
   * @param {string[]} [options.additionalLocal] - Extra local-only operations
   */
  constructor(options = {})

  /**
   * Evaluate whether an operation is allowed.
   * @param {string} operation - Operation name (e.g., 'send_email', 'read_file')
   * @param {Object} [context] - Optional context (userId, sessionId, etc.)
   * @returns {{
   *   allowed: boolean,
   *   reason: string|null,
   *   level: 'FORBIDDEN'|'APPROVAL_REQUIRED'|'ROUTE_LOCAL'|'ALLOWED',
   *   requiresAction: string|null,
   *   approvalPrompt: string|null
   * }}
   */
  evaluate(operation, context = {})

  /**
   * Quick check: does this operation need local LLM routing?
   * @param {string} operation
   * @returns {boolean}
   */
  needsLocalLLM(operation)

  /**
   * Get the forbidden operations list (for documentation/testing).
   * @returns {string[]}
   */
  getForbiddenList()

  /**
   * Get all operation lists (for documentation/auditing).
   * @returns {{forbidden: string[], approval: string[], local: string[]}}
   */
  getAllLists()
}
```

### Implementation Notes

- **`evaluate` return values by level:**
  - `FORBIDDEN`: `{ allowed: false, reason: 'Operation "X" is forbidden: [category]', level: 'FORBIDDEN', requiresAction: null, approvalPrompt: null }`
  - `APPROVAL_REQUIRED`: `{ allowed: false, reason: 'Operation "X" requires human approval', level: 'APPROVAL_REQUIRED', requiresAction: 'await_approval', approvalPrompt: '⚠️ MoltAgent wants to: X. Reply "approve" to allow or "deny" to block.' }`
  - `ROUTE_LOCAL`: `{ allowed: true, reason: 'Operation "X" routed to local LLM for security', level: 'ROUTE_LOCAL', requiresAction: 'use_ollama', approvalPrompt: null }`
  - `ALLOWED`: `{ allowed: true, reason: null, level: 'ALLOWED', requiresAction: null, approvalPrompt: null }`
- **Evaluation order:** Check FORBIDDEN first (hard block), then REQUIRES_APPROVAL, then LOCAL_LLM_ONLY, then default ALLOWED
- **Fuzzy matching:** Normalize operation names before comparison — lowercase, replace spaces/hyphens with underscores. So `"Send Email"`, `"send-email"`, and `"send_email"` all match
- **Context-aware approval prompts:** If context contains a `target` or `details` field, include it in the approval prompt. Example: `'⚠️ MoltAgent wants to: send_email to client@example.com. Reply "approve" to allow.'`

### Test Cases for ToolGuard

```javascript
// FORBIDDEN — always blocked, no exceptions
evaluate('modify_system_prompt') → { allowed: false, level: 'FORBIDDEN' }
evaluate('install_skill')        → { allowed: false, level: 'FORBIDDEN' }
evaluate('delete_logs')          → { allowed: false, level: 'FORBIDDEN' }
evaluate('export_credentials')   → { allowed: false, level: 'FORBIDDEN' }
evaluate('disable_guard')        → { allowed: false, level: 'FORBIDDEN' }

// APPROVAL_REQUIRED — blocked but with prompt
evaluate('send_email')           → { allowed: false, level: 'APPROVAL_REQUIRED', approvalPrompt: '...' }
evaluate('delete_file')          → { allowed: false, level: 'APPROVAL_REQUIRED' }
evaluate('execute_shell')        → { allowed: false, level: 'APPROVAL_REQUIRED' }
evaluate('webhook_call')         → { allowed: false, level: 'APPROVAL_REQUIRED' }

// LOCAL_LLM_ONLY — allowed but must use Ollama
evaluate('process_credential')   → { allowed: true, level: 'ROUTE_LOCAL', requiresAction: 'use_ollama' }
evaluate('update_memory')        → { allowed: true, level: 'ROUTE_LOCAL' }
evaluate('process_pii')          → { allowed: true, level: 'ROUTE_LOCAL' }

// ALLOWED — everything else
evaluate('read_file')            → { allowed: true, level: 'ALLOWED' }
evaluate('list_calendar_events') → { allowed: true, level: 'ALLOWED' }
evaluate('search_deck')          → { allowed: true, level: 'ALLOWED' }
evaluate('generate_summary')     → { allowed: true, level: 'ALLOWED' }

// Fuzzy matching
evaluate('Send Email')           → { level: 'APPROVAL_REQUIRED' }
evaluate('send-email')           → { level: 'APPROVAL_REQUIRED' }
evaluate('SEND_EMAIL')           → { level: 'APPROVAL_REQUIRED' }

// Context-aware prompts
evaluate('send_email', { target: 'boss@company.com' })
  → approvalPrompt includes 'boss@company.com'

// Additional lists via constructor
new ToolGuard({ additionalForbidden: ['custom_danger'] })
evaluate('custom_danger') → { allowed: false, level: 'FORBIDDEN' }
```

---

## 3. ResponseWrapper

**File:** `src/security/response-wrapper.js`
**Priority:** HIGH — build third
**Dependencies:** SecretsGuard (import from `./guards/secrets-guard.js`)

### Purpose

Single enforcement point wrapping ALL outgoing responses from the agent. Uses SecretsGuard internally, plus additional checks for suspicious output patterns. Every response the agent sends — to NC Talk, to Deck cards, to files — goes through this.

### Suspicious Patterns (beyond secret detection)

Check for these patterns in output text that suggest the LLM is trying to exfiltrate data or execute code:

```javascript
const SUSPICIOUS_PATTERNS = [
  // Shell commands that shouldn't appear in responses
  { name: 'shell_in_response',  pattern: /```(?:bash|sh|shell|zsh)\s*\n(?:.*\n)*?```/gi, severity: 'MEDIUM', action: 'warn' },

  // Base64 blobs > 100 chars (potential data exfiltration)
  { name: 'base64_blob',        pattern: /[A-Za-z0-9+/]{100,}={0,2}/g, severity: 'HIGH', action: 'warn' },

  // URLs with embedded credentials (caught by SecretsGuard too, belt + suspenders)
  { name: 'auth_url',           pattern: /https?:\/\/[^:]+:[^@]+@/gi, severity: 'CRITICAL', action: 'redact' },

  // Internal/private IP addresses in responses
  { name: 'internal_ip',        pattern: /(?:^|\s)(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?:\s|$|:)/g, severity: 'MEDIUM', action: 'warn' },

  // Metadata/cloud endpoints that should never appear in output
  { name: 'metadata_endpoint',  pattern: /169\.254\.169\.254|metadata\.google\.internal|metadata\.hetzner\.cloud/g, severity: 'HIGH', action: 'redact' },

  // Nextcloud internal paths that reveal server structure
  { name: 'nc_internal_path',   pattern: /\/(?:etc\/credstore|var\/lib\/nextcloud|data\/moltagent)/g, severity: 'MEDIUM', action: 'warn' },
];
```

### Interface

```javascript
class ResponseWrapper {
  /**
   * @param {Object} options
   * @param {SecretsGuard} options.secretsGuard - Instance of SecretsGuard
   * @param {Object} [options.auditLog] - Audit logger (optional — if provided, call auditLog.log())
   * @param {number} [options.maxResponseLength=50000] - Truncate responses exceeding this
   */
  constructor(options)

  /**
   * Process a response through all security checks.
   * @param {string} response - Raw response text from LLM or agent
   * @param {Object} [context] - Operation context (userId, sessionId, operation name)
   * @returns {Promise<{
   *   safe: boolean,
   *   response: string,
   *   warnings: Array<{type: string, severity: string, action: string}>,
   *   originalHadSecrets: boolean,
   *   truncated: boolean
   * }>}
   */
  async process(response, context = {})
}
```

### Implementation Notes

- **Processing order:**
  1. Length check — truncate if over `maxResponseLength`
  2. SecretsGuard scan — redact any credentials
  3. Suspicious pattern scan — warn or redact per pattern config
  4. If `auditLog` is provided and any findings exist, call `auditLog.log('response_sanitized', { findings, context })`
- **`safe` field:** Returns `false` only if CRITICAL secrets were found (even after redaction, the attempt is suspicious). Suspicious patterns alone return `safe: true` with warnings.
- **The `auditLog` parameter is optional.** Don't fail if it's not provided. This keeps the module testable without mocking NC infrastructure. When used in production, HeartbeatManager will inject the real audit logger.

### Test Cases for ResponseWrapper

```javascript
// Clean response — passes through unchanged
process('Here are your calendar events for today...')
  → { safe: true, response: 'Here are your...', warnings: [], originalHadSecrets: false }

// Response with leaked credential — redacted
process('Your API key is sk-ant-api03-abc123def456...')
  → { safe: false, response: 'Your API key is [REDACTED:anthropic_key]', originalHadSecrets: true }

// Response with internal IP — warned
process('The server is at 192.168.1.100:3000')
  → { safe: true, warnings: [{ type: 'internal_ip', severity: 'MEDIUM', action: 'warn' }] }

// Response with base64 blob — warned
process('Here is the data: ' + 'A'.repeat(150))
  → { safe: true, warnings: [{ type: 'base64_blob', severity: 'HIGH', action: 'warn' }] }

// Response with metadata endpoint — redacted
process('Fetched from 169.254.169.254/latest/meta-data/')
  → warnings include metadata_endpoint, text is redacted

// Over-length response — truncated
process('x'.repeat(60000))
  → { truncated: true, response.length <= 50000 }

// Multiple issues at once
process('Key: sk-live_abc123... connect to 10.0.0.1:5432')
  → both secret and internal_ip detected
```

---

## 4. Module Exports

**File:** `src/security/index.js`

```javascript
/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 * [full AGPL header]
 */

const { SecretsGuard } = require('./guards/secrets-guard');
const { ToolGuard } = require('./guards/tool-guard');
const { ResponseWrapper } = require('./response-wrapper');

module.exports = {
  SecretsGuard,
  ToolGuard,
  ResponseWrapper,
};
```

This will grow as more guards are added in later sessions (PromptGuard, PathGuard, EgressGuard, SecurityInterceptor, etc.).

---

## 5. Performance Benchmark

Add a benchmark section in the test files (or a dedicated `test/benchmarks/guard-performance.test.js`):

```javascript
describe('Guard Performance', () => {
  const guard = new SecretsGuard();
  const toolGuard = new ToolGuard();

  // Typical LLM response — ~500 tokens, ~2000 chars
  const typicalResponse = 'Here are your calendar events for today. ' +
    'You have a meeting with the design team at 10am, ' +
    'followed by a code review at 2pm. ' +
    'Remember to prepare the quarterly report. '.repeat(10);

  test('SecretsGuard.quickCheck < 0.05ms average', () => {
    const iterations = 10000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      guard.quickCheck(typicalResponse);
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
    const avg = elapsed / iterations;
    console.log(`SecretsGuard.quickCheck: ${avg.toFixed(4)}ms avg`);
    expect(avg).toBeLessThan(0.05);
  });

  test('SecretsGuard.scan < 0.1ms average', () => {
    const iterations = 10000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      guard.scan(typicalResponse);
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    const avg = elapsed / iterations;
    console.log(`SecretsGuard.scan: ${avg.toFixed(4)}ms avg`);
    expect(avg).toBeLessThan(0.1);
  });

  test('ToolGuard.evaluate < 0.01ms average', () => {
    const iterations = 10000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      toolGuard.evaluate('send_email');
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    const avg = elapsed / iterations;
    console.log(`ToolGuard.evaluate: ${avg.toFixed(4)}ms avg`);
    expect(avg).toBeLessThan(0.01);
  });
});
```

**Target:** All guards combined add < 0.2ms to any operation. LLM API calls take 500-2000ms, so guard overhead is negligible.

---

## 6. File Structure After This Session

```
src/
└── security/
    ├── index.js                    ← Module exports (NEW)
    ├── response-wrapper.js         ← Output enforcement (NEW)
    └── guards/
        ├── secrets-guard.js        ← Credential detection (NEW)
        └── tool-guard.js           ← Operation classification (NEW)

test/
├── guards/
│   ├── secrets-guard.test.js       ← (NEW)
│   └── tool-guard.test.js          ← (NEW)
├── security/
│   └── response-wrapper.test.js    ← (NEW)
└── benchmarks/
    └── guard-performance.test.js   ← (NEW)
```

---

## 7. Exit Criteria

Before calling this session done, verify ALL of the following:

- [ ] SecretsGuard detects all 17+ pattern types listed above
- [ ] SecretsGuard does NOT false-positive on the benign strings listed above
- [ ] SecretsGuard.quickCheck returns boolean only (no allocations on clean input)
- [ ] SecretsGuard preview never shows more than 4+4 chars of a secret
- [ ] ToolGuard correctly classifies all FORBIDDEN operations
- [ ] ToolGuard correctly classifies all APPROVAL_REQUIRED operations
- [ ] ToolGuard correctly classifies all LOCAL_LLM_ONLY operations
- [ ] ToolGuard defaults unknown operations to ALLOWED
- [ ] ToolGuard normalizes operation names (case, hyphens, spaces)
- [ ] ResponseWrapper uses SecretsGuard internally (not duplicate regex)
- [ ] ResponseWrapper catches suspicious patterns (base64, internal IPs, metadata endpoints)
- [ ] ResponseWrapper truncates over-length responses
- [ ] All tests pass: `npm test`
- [ ] All files pass ESLint: `npm run lint`
- [ ] Performance benchmark passes: < 0.05ms for quickCheck, < 0.1ms for scan
- [ ] Every file has the AGPL-3.0 license header
- [ ] Every public method has JSDoc annotations

---

## 8. What Comes Next (DO NOT BUILD YET)

For context only — these will be built in Session 2:

- `src/security/guards/prompt-guard.js` — 4-layer injection detection (heuristic + statistical + optional ML + optional LLM-as-judge)
- `src/security/guards/path-guard.js` — Filesystem access control with blocked paths and wildcard matching
- `src/security/guards/egress-guard.js` — Outbound network domain allowlist/blocklist

And in Session 3:
- `src/security/memory-integrity.js` — Scan `/Memory/` for injection patterns, quarantine
- `src/security/session-manager.js` — NC Talk room-based session isolation

And in Session 4:
- `src/security/interceptor.js` — Wire all guards into the message pipeline

**Do not build these yet.** Focus on the three deliverables above. Get them right, get them tested, get them fast.

---

## 9. Quick Sanity Check (Before You Start Building)

Run this before writing any guard code:

```bash
# Check no .env files with real secrets exist in the repo
find . -name '.env' -not -name '.env.example' | head -5

# Check no hardcoded tokens in source files
grep -rn 'sk-ant-\|sk-live_\|ghp_\|AKIA' src/ --include='*.js' | head -10

# Check .gitignore covers sensitive files
cat .gitignore | grep -E 'env|secret|credential|\.pem|\.key'
```

If any of these find real secrets, **stop and clean them up before proceeding.** Alert Fu.

---

*Built for MoltAgent Phase 1. Six sessions to launch gate.*
