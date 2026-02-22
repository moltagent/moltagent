#!/usr/bin/env node
/**
 * Moltagent Wiring Audit
 *
 * Scans the codebase for disconnected capabilities:
 * - Client methods with no tool handler
 * - Tools with no security classification
 * - Missing error handling in tool handlers
 * - SOUL.md references to nonexistent tools
 * - Tool subset gaps
 * - Incomplete approval paths
 *
 * Read-only. Modifies nothing. Outputs report to stdout and file.
 *
 * Usage: node tools/audit/wiring-audit.js [--verbose] [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Configuration ───────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../..');

const CONFIG = {
  clientPaths: [
    'src/lib/integrations/deck-client.js',
    'src/lib/integrations/caldav-client.js',
    'src/lib/integrations/collectives-client.js',
    'src/lib/integrations/contacts-client.js',
    'src/lib/integrations/nc-files-client.js',
    'src/lib/integrations/nc-search-client.js',
    'src/lib/integrations/searxng-client.js',
    'src/lib/integrations/web-reader.js',
    'src/lib/clients/self-heal-client.js',
  ],
  toolRegistryPath: 'src/lib/agent/tool-registry.js',
  toolGuardPath: 'src/security/guards/tool-guard.js',
  guardrailEnforcerPath: 'src/lib/agent/guardrail-enforcer.js',
  soulMdPath: 'config/SOUL.md',
  reportOutputPath: 'tools/audit/wiring-report.md',
  // Files that consume client methods (beyond tool-registry)
  consumerGlobs: [
    'src/lib/agent/tool-registry.js',
    'src/lib/agent/agent-loop.js',
    'src/lib/integrations/heartbeat-manager.js',
    'src/lib/integrations/heartbeat-intelligence.js',
    'src/lib/integrations/deck-task-processor.js',
    'src/lib/integrations/cockpit-manager.js',
    'src/lib/integrations/rsvp-tracker.js',
    'src/lib/integrations/memory-searcher.js',
    'src/lib/integrations/session-persister.js',
    'src/lib/integrations/warm-memory.js',
    'src/lib/handlers/calendar-handler.js',
    'src/lib/handlers/message-router.js',
    'src/lib/handlers/email-handler.js',
    'src/lib/handlers/skill-forge-handler.js',
    'src/lib/knowledge/knowledge-board.js',
    'src/lib/workflows/workflow-engine.js',
    'src/lib/workflows/workflow-board-detector.js',
    'src/lib/workflows/gate-detector.js',
    'webhook-server.js',
    'src/bot.js',
  ],
};

// ── CLI flags ───────────────────────────────────────────────────

const VERBOSE = process.argv.includes('--verbose');
const JSON_OUTPUT = process.argv.includes('--json');

// ── Color helpers (ANSI, stripped for file output) ──────────────

const c = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue:   (s) => `\x1b[36m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── File helpers ────────────────────────────────────────────────

function readFile(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf-8');
}

function globExpand(patterns) {
  const files = [];
  for (const p of patterns) {
    const abs = path.join(ROOT, p);
    if (fs.existsSync(abs)) {
      files.push(p);
    }
  }
  return files;
}

function findFilesRecursive(dir, pattern) {
  const results = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return results;
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  for (const e of entries) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...findFilesRecursive(rel, pattern));
    } else if (pattern.test(e.name)) {
      results.push(rel);
    }
  }
  return results;
}

// ── Extraction helpers ──────────────────────────────────────────

/**
 * Extract public method names from a JS class file.
 * Matches: `  async methodName(` or `  methodName(`
 * Excludes: constructor, _private methods, static, get/set
 */
function extractPublicMethods(source, filePath) {
  const methods = [];
  const lines = source.split('\n');

  // Find all class declarations and their line ranges
  const classes = [];
  for (let i = 0; i < lines.length; i++) {
    const cm = lines[i].match(/^class\s+(\w+)/);
    if (cm) classes.push({ name: cm[1], startLine: i });
  }

  // Use the primary (last non-Error) class, or first class
  const primaryClass = classes.filter(c => !c.name.includes('Error')).pop()
    || classes[0]
    || { name: path.basename(filePath, '.js'), startLine: 0 };
  const className = primaryClass.name;

  // Keywords that can appear as function-call-like patterns but aren't methods
  const nonMethodKeywords = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'throw',
    'new', 'typeof', 'function', 'super', 'await', 'yield', 'delete',
    'require', 'import', 'export', 'const', 'let', 'var',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match method definitions at class body level (2-4 spaces indent)
    const m = line.match(/^\s{2,4}(?:async\s+)?([a-zA-Z$][a-zA-Z0-9$]*)\s*\(/);
    if (!m) continue;
    const name = m[1];
    // Skip constructor, private, static getters/setters
    if (name === 'constructor') continue;
    if (name.startsWith('_')) continue;
    if (/^\s{2,4}(?:get|set|static)\s/.test(line)) continue;
    // Skip non-method keywords
    if (nonMethodKeywords.has(name)) continue;

    // Determine which class this method belongs to (skip Error subclasses)
    let ownerClass = className;
    for (const cls of classes) {
      if (i >= cls.startLine) ownerClass = cls.name;
    }
    if (ownerClass.includes('Error')) continue;

    methods.push({ name, line: i + 1, className: ownerClass });
  }
  return { className, methods };
}

/**
 * Extract registered tool names from tool-registry.js
 */
function extractRegisteredTools(source) {
  const tools = [];
  const re = /name:\s*'([a-z_]+)'/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    // Find line number
    const before = source.slice(0, m.index);
    const line = before.split('\n').length;
    tools.push({ name: m[1], line });
  }
  return tools;
}

/**
 * Extract tool names from an array literal in source code.
 * Searches for the arrayName declaration and extracts quoted strings.
 */
function extractArrayEntries(source, arrayName) {
  const entries = [];
  // Find the array/set block by name
  const patterns = [
    // const NAME = [ ... ]
    new RegExp(`(?:const|let|var)\\s+${arrayName}\\s*=\\s*\\[([\\s\\S]*?)\\];`),
    // const NAME = new Set([ ... ])
    new RegExp(`(?:const|let|var)\\s+${arrayName}\\s*=\\s*new\\s+Set\\(\\[([\\s\\S]*?)\\]\\)`),
  ];
  for (const pat of patterns) {
    const match = source.match(pat);
    if (match) {
      const block = match[1];
      const re = /'([a-z_]+)'/g;
      let m;
      while ((m = re.exec(block)) !== null) {
        entries.push(m[1]);
      }
      return entries;
    }
  }
  return entries;
}

/**
 * Extract object keys from a const object literal.
 */
function extractObjectKeys(source, objectName) {
  const keys = [];
  // Match: const NAME = { ... };
  const pat = new RegExp(`(?:const|let|var)\\s+${objectName}\\s*=\\s*\\{([\\s\\S]*?)\\};`);
  const match = source.match(pat);
  if (!match) return keys;
  const block = match[1];
  const re = /^\s*([a-z_]+)\s*:/gm;
  let m;
  while ((m = re.exec(block)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

/**
 * Extract tool subsets from getToolSubset().
 */
function extractToolSubsets(source) {
  const subsets = {};
  // Find SUBSETS object inside getToolSubset
  const funcMatch = source.match(/getToolSubset\s*\([^)]*\)\s*\{([\s\S]*?)^\s{2}\}/m);
  if (!funcMatch) return subsets;
  const funcBody = funcMatch[1];

  // Find the SUBSETS = { ... } block
  const subsetsMatch = funcBody.match(/SUBSETS\s*=\s*\{([\s\S]*?)\n\s{4}\};/);
  if (!subsetsMatch) return subsets;
  const subsetsBlock = subsetsMatch[1];

  // Parse each subset: key: [ 'tool1', 'tool2', ... ]
  const re = /(\w+):\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(subsetsBlock)) !== null) {
    const name = m[1];
    const tools = [];
    const toolRe = /'([a-z_]+)'/g;
    let tm;
    while ((tm = toolRe.exec(m[2])) !== null) {
      tools.push(tm[1]);
    }
    subsets[name] = tools;
  }
  return subsets;
}

/**
 * Extract switch cases from a function in source code.
 * Returns array of case values found.
 */
function extractSwitchCases(source, functionName) {
  const cases = [];
  // Find the function body
  const pat = new RegExp(`${functionName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s{2}\\}`, 'm');
  const match = source.match(pat);
  if (!match) return cases;
  const body = match[1];
  const re = /case\s+'([a-z_]+)'/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    cases.push(m[1]);
  }
  return cases;
}

// ── Scanner 1: Orphaned Client Methods ──────────────────────────

function scanOrphanedMethods() {
  const findings = [];
  const clientFiles = globExpand(CONFIG.clientPaths);
  const consumerFiles = globExpand(CONFIG.consumerGlobs);

  // Also search within the client files themselves (internal cross-calls)
  const allSearchFiles = [...new Set([...consumerFiles, ...clientFiles])];

  // Load all consumer source content
  const consumerSources = {};
  for (const f of allSearchFiles) {
    consumerSources[f] = readFile(f) || '';
  }

  // Also search any additional JS files in src/lib that might reference methods
  const additionalDirs = ['src/lib/integrations', 'src/lib/handlers', 'src/lib/workflows', 'src/lib/knowledge', 'src/lib/agent'];
  for (const dir of additionalDirs) {
    const files = findFilesRecursive(dir, /\.js$/);
    for (const f of files) {
      if (!consumerSources[f]) {
        consumerSources[f] = readFile(f) || '';
      }
    }
  }

  for (const clientFile of clientFiles) {
    const source = readFile(clientFile);
    if (!source) continue;

    const { className, methods } = extractPublicMethods(source, clientFile);

    for (const method of methods) {
      // Check if method is referenced externally
      let foundExternal = false;
      let foundInternal = false;
      const refFiles = [];

      for (const [file, content] of Object.entries(consumerSources)) {
        if (file === clientFile) {
          // Check for internal use: `this.methodName(`
          if (new RegExp(`\\.${method.name}\\s*\\(`).test(content)) {
            // Distinguish self-call from definition
            const selfCalls = content.match(new RegExp(`this\\.${method.name}\\s*\\(`, 'g'));
            if (selfCalls && selfCalls.length > 0) {
              foundInternal = true;
            }
          }
        } else {
          // External reference: `.methodName(`
          if (new RegExp(`\\.${method.name}\\s*\\(`).test(content)) {
            foundExternal = true;
            refFiles.push(path.basename(file));
          }
        }
      }

      if (foundExternal) {
        if (VERBOSE) {
          findings.push({
            severity: 'pass',
            message: `${className}.${method.name}() — referenced by ${refFiles.join(', ')}`,
          });
        }
      } else if (foundInternal) {
        findings.push({
          severity: 'info',
          message: `${className}.${method.name}() — internal use only (called by other methods in same class)`,
        });
      } else {
        findings.push({
          severity: 'warning',
          message: `${className}.${method.name}() — no external references found`,
          file: clientFile,
          line: method.line,
        });
      }
    }
  }

  return findings;
}

// ── Scanner 2: Unguarded Tools ──────────────────────────────────

function scanUnguardedTools() {
  const findings = [];

  const registrySource = readFile(CONFIG.toolRegistryPath);
  const guardSource = readFile(CONFIG.toolGuardPath);
  const enforcerSource = readFile(CONFIG.guardrailEnforcerPath);

  if (!registrySource || !guardSource || !enforcerSource) {
    findings.push({ severity: 'warning', message: 'Could not read one or more source files' });
    return findings;
  }

  const registeredTools = extractRegisteredTools(registrySource).map(t => t.name);

  // ToolGuard lists
  const forbidden = extractArrayEntries(guardSource, 'FORBIDDEN');
  const approval = extractArrayEntries(guardSource, 'REQUIRES_APPROVAL');
  const localOnly = extractArrayEntries(guardSource, 'LOCAL_LLM_ONLY');
  const allGuarded = new Set([...forbidden, ...approval, ...localOnly]);

  // GuardrailEnforcer lists
  const sensitiveTools = extractArrayEntries(enforcerSource, 'SENSITIVE_TOOLS');
  const toolCategories = extractObjectKeys(enforcerSource, 'TOOL_CATEGORIES');
  const keywordMap = extractObjectKeys(enforcerSource, 'KEYWORD_FALLBACK_MAP');
  const approvalLabels = extractObjectKeys(enforcerSource, 'TOOL_APPROVAL_LABELS');

  // Check registered tools against guard
  // Tools can be secured in two ways:
  //   1. ToolGuard lists (FORBIDDEN, REQUIRES_APPROVAL, LOCAL_LLM_ONLY) — hardcoded
  //   2. GuardrailEnforcer SENSITIVE_TOOLS — Cockpit-governed, dynamic
  // Only flag tools that are in NEITHER system and perform destructive/external actions.
  const sensitiveSet = new Set(sensitiveTools);
  const destructivePatterns = /delete|trash|send|share/;
  for (const tool of registeredTools) {
    if (!allGuarded.has(tool) && !sensitiveSet.has(tool)) {
      if (destructivePatterns.test(tool)) {
        findings.push({
          severity: 'warning',
          message: `${tool} — destructive tool not in ToolGuard OR SENSITIVE_TOOLS (defaults to ALLOWED, no guardrails)`,
        });
      } else if (VERBOSE) {
        findings.push({
          severity: 'pass',
          message: `${tool} — not in ToolGuard (defaults to ALLOWED, non-destructive)`,
        });
      }
    } else if (!allGuarded.has(tool) && sensitiveSet.has(tool)) {
      if (VERBOSE) {
        findings.push({
          severity: 'info',
          message: `${tool} — not in ToolGuard but covered by SENSITIVE_TOOLS (Cockpit GATE flow)`,
        });
      }
    }
  }

  // Check for stale guard entries (in guard but not registered)
  const registeredSet = new Set(registeredTools);
  for (const tool of approval) {
    if (!registeredSet.has(tool)) {
      findings.push({
        severity: 'info',
        message: `${tool} — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)`,
      });
    }
  }
  for (const tool of forbidden) {
    if (!registeredSet.has(tool)) {
      if (VERBOSE) {
        findings.push({
          severity: 'info',
          message: `${tool} — in FORBIDDEN but not registered (intentional blocker)`,
        });
      }
    }
  }

  // Check REQUIRES_APPROVAL tools against GuardrailEnforcer
  const approvalLabelSet = new Set(approvalLabels);

  for (const tool of approval) {
    if (!sensitiveSet.has(tool) && registeredSet.has(tool)) {
      findings.push({
        severity: 'info',
        message: `${tool} — in REQUIRES_APPROVAL but not in SENSITIVE_TOOLS (bypasses Cockpit GATE flow, uses ToolGuard HITL only)`,
      });
    }
    if (!approvalLabelSet.has(tool) && registeredSet.has(tool)) {
      findings.push({
        severity: 'warning',
        message: `${tool} — in REQUIRES_APPROVAL but missing from TOOL_APPROVAL_LABELS`,
      });
    }
  }

  return findings;
}

// ── Scanner 3: Inconsistent Error Handling ──────────────────────

function scanErrorHandling() {
  const findings = [];
  const source = readFile(CONFIG.toolRegistryPath);
  if (!source) return findings;

  const lines = source.split('\n');

  // Find handler blocks by looking for `handler: async (args) => {`
  // Then check if the main await calls have try/catch
  let inHandler = false;
  let handlerStart = 0;
  let braceDepth = 0;
  let currentTool = '';
  let handlerLines = [];
  const handlers = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect tool name from `name: 'tool_name'`
    const nameMatch = line.match(/name:\s*'([a-z_]+)'/);
    if (nameMatch) {
      currentTool = nameMatch[1];
    }

    // Detect handler start
    if (/handler:\s*async\s*\(/.test(line)) {
      inHandler = true;
      handlerStart = i;
      braceDepth = 0;
      handlerLines = [];
      // Count braces on this line
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }
      handlerLines.push({ text: line, num: i + 1 });
      continue;
    }

    if (inHandler) {
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }
      handlerLines.push({ text: line, num: i + 1 });

      if (braceDepth <= 0) {
        handlers.push({
          tool: currentTool,
          startLine: handlerStart + 1,
          lines: handlerLines,
        });
        inHandler = false;
      }
    }
  }

  // Analyze each handler
  for (const handler of handlers) {
    const fullText = handler.lines.map(l => l.text).join('\n');
    const awaitLines = handler.lines.filter(l => /\bawait\b/.test(l.text));

    if (awaitLines.length === 0) continue; // sync handler, skip

    const hasTryCatch = /\btry\s*\{/.test(fullText);

    // Find the first significant await (skip simple resolveCollective, findPageByTitle)
    const significantAwaits = awaitLines.filter(l => {
      const t = l.text.trim();
      // Skip simple setup calls that are expected to succeed
      if (/resolveCollective\(\)/.test(t)) return false;
      if (/findPageByTitle\(/.test(t)) return false;
      if (/_ensureWikilinkCache\(\)/.test(t)) return false;
      return true;
    });

    if (significantAwaits.length === 0) continue;

    // Check if each significant await is wrapped in try/catch
    // Heuristic: check if there's a try { before the await and catch after
    if (!hasTryCatch) {
      const firstAwait = significantAwaits[0];
      findings.push({
        severity: 'warning',
        message: `${handler.tool} — await at line ${firstAwait.num} has no try/catch in handler`,
        file: CONFIG.toolRegistryPath,
        line: firstAwait.num,
      });
    } else if (VERBOSE) {
      findings.push({
        severity: 'pass',
        message: `${handler.tool} — handler has try/catch`,
      });
    }
  }

  return findings;
}

// ── Scanner 4: SOUL.md ↔ Code Drift ────────────────────────────

function scanSoulDrift() {
  const findings = [];
  const soulSource = readFile(CONFIG.soulMdPath);
  const registrySource = readFile(CONFIG.toolRegistryPath);

  if (!soulSource || !registrySource) {
    findings.push({ severity: 'warning', message: 'Could not read SOUL.md or tool-registry.js' });
    return findings;
  }

  const registeredTools = new Set(extractRegisteredTools(registrySource).map(t => t.name));

  // Extract tool references from SOUL.md — look for **tool_name** and `tool_name` patterns
  const soulLines = soulSource.split('\n');
  const toolRefPattern = /\*\*([a-z_]+)\*\*|`([a-z_]+)`/g;
  const soulTools = new Map(); // tool -> [line numbers]

  for (let i = 0; i < soulLines.length; i++) {
    const line = soulLines[i];
    let m;
    toolRefPattern.lastIndex = 0;
    while ((m = toolRefPattern.exec(line)) !== null) {
      const toolName = m[1] || m[2];
      // Only consider names that look like tool names (have underscore, known prefixes)
      if (!toolName.includes('_')) continue;
      // Skip known parameter names and non-tool patterns
      if (/^(decay_days|last_verified|page_title|card_id|board_id|stack_id|target_stack|target_stack_id|due_date|label_name|event_uid|calendar_id|frontmatter|confidence_level|trust_level|from_path|to_path|share_with|time_range|all_day|stack_name|board_name|file_path|attendee_email|share_type|permission_edit|permission_share|permission_manage|user_id|display_name|phone_number|email_address|job_title|start_date|end_date|event_title|sort_order|max_results|search_query|include_body|provider_ids|date_time|duration_minutes)$/.test(toolName)) continue;

      if (!soulTools.has(toolName)) {
        soulTools.set(toolName, []);
      }
      soulTools.get(toolName).push(i + 1);
    }
  }

  // Also look for plain snake_case words that match tool name patterns
  const plainToolPattern = /\b((?:deck|wiki|file|calendar|mail|contacts|web|memory|tag|unified|workflow|talk|notification)_[a-z_]+)\b/g;
  for (let i = 0; i < soulLines.length; i++) {
    const line = soulLines[i];
    let m;
    plainToolPattern.lastIndex = 0;
    while ((m = plainToolPattern.exec(line)) !== null) {
      const toolName = m[1];
      // Skip parameter names that happen to match tool prefixes (e.g. calendar_id)
      if (/^(calendar_id|file_path|deck_id|wiki_id|contacts_id|mail_id)$/.test(toolName)) continue;
      if (!soulTools.has(toolName)) {
        soulTools.set(toolName, []);
      }
      const arr = soulTools.get(toolName);
      if (!arr.includes(i + 1)) arr.push(i + 1);
    }
  }

  // Cross-reference: SOUL mentions vs registry
  for (const [tool, lines] of soulTools) {
    if (registeredTools.has(tool)) {
      if (VERBOSE) {
        findings.push({
          severity: 'pass',
          message: `${tool} — mentioned in SOUL.md line ${lines[0]}, registered`,
        });
      }
    } else {
      findings.push({
        severity: 'warning',
        message: `${tool} — mentioned in SOUL.md line(s) ${lines.join(', ')} but NOT registered as a tool`,
      });
    }
  }

  // Inverse: registered tools not in SOUL.md
  for (const tool of registeredTools) {
    if (!soulTools.has(tool)) {
      // Workflow tools are internal, not user-facing — skip
      if (tool.startsWith('workflow_')) continue;
      findings.push({
        severity: 'info',
        message: `${tool} — registered but not mentioned in SOUL.md (agent may not know to use it)`,
      });
    }
  }

  return findings;
}

// ── Scanner 5: Tool Subset Gaps ─────────────────────────────────

function scanSubsetGaps() {
  const findings = [];
  const source = readFile(CONFIG.toolRegistryPath);
  if (!source) return findings;

  const registeredTools = extractRegisteredTools(source).map(t => t.name);
  const subsets = extractToolSubsets(source);

  // Build set of all tools in any subset
  const allSubsetTools = new Set();
  for (const tools of Object.values(subsets)) {
    for (const t of tools) allSubsetTools.add(t);
  }

  // Prefix-to-subset mapping
  const prefixMap = {
    deck_: 'deck',
    calendar_: 'calendar',
    file_: 'file',
    wiki_: 'wiki',
    mail_: 'email',
    web_: 'search',
    contacts_: 'search',
    memory_: 'search',
    unified_: 'search',
  };

  for (const tool of registeredTools) {
    // Skip workflow tools — they have their own definitions
    if (tool.startsWith('workflow_')) continue;

    // Find expected subset based on prefix
    let expectedSubset = null;
    for (const [prefix, subset] of Object.entries(prefixMap)) {
      if (tool.startsWith(prefix)) {
        expectedSubset = subset;
        break;
      }
    }

    if (expectedSubset && subsets[expectedSubset]) {
      if (subsets[expectedSubset].includes(tool)) {
        if (VERBOSE) {
          findings.push({
            severity: 'pass',
            message: `${tool} — in '${expectedSubset}' subset`,
          });
        }
      } else {
        // Subsets are intentionally capped at ~5 tools for Qwen 8B on CPU.
        // More tools than the cap is expected — only flag as warning if the subset
        // has room (fewer than 5 entries) or the tool is clearly essential.
        const subsetSize = subsets[expectedSubset].length;
        const severity = subsetSize < 5 ? 'warning' : 'info';
        findings.push({
          severity,
          message: `${tool} — prefix suggests '${expectedSubset}' subset but NOT included (subset has ${subsetSize}/5 slots)`,
        });
      }
    } else if (!allSubsetTools.has(tool)) {
      if (VERBOSE) {
        findings.push({
          severity: 'info',
          message: `${tool} — not in any subset (cloud-only or full-registry access only)`,
        });
      }
    }
  }

  // Also check cloud workflow tool definitions for context scan gaps
  // Look for `mail_draft` vs `mail_send` mismatch
  const cloudMatch = source.match(/getCloudWorkflowToolDefinitions[\s\S]*?return Array/);
  if (cloudMatch) {
    const block = cloudMatch[0];
    if (block.includes("'mail_draft'") && !registeredTools.includes('mail_draft')) {
      findings.push({
        severity: 'warning',
        message: `getCloudWorkflowToolDefinitions references 'mail_draft' but only 'mail_send' is registered`,
      });
    }
    if (block.includes("'talk_send'") && !registeredTools.includes('talk_send')) {
      findings.push({
        severity: 'warning',
        message: `getCloudWorkflowToolDefinitions references 'talk_send' but it is not registered`,
      });
    }
  }

  return findings;
}

// ── Scanner 6: Approval Path Completeness ───────────────────────

function scanApprovalPaths() {
  const findings = [];

  const guardSource = readFile(CONFIG.toolGuardPath);
  const enforcerSource = readFile(CONFIG.guardrailEnforcerPath);
  const registrySource = readFile(CONFIG.toolRegistryPath);

  if (!guardSource || !enforcerSource || !registrySource) {
    findings.push({ severity: 'warning', message: 'Could not read required files' });
    return findings;
  }

  const registeredTools = new Set(extractRegisteredTools(registrySource).map(t => t.name));
  const approvalTools = extractArrayEntries(guardSource, 'REQUIRES_APPROVAL');
  const sensitiveTools = extractArrayEntries(enforcerSource, 'SENSITIVE_TOOLS');

  // GuardrailEnforcer entry points for approval tools
  const approvalLabels = new Set(extractObjectKeys(enforcerSource, 'TOOL_APPROVAL_LABELS'));
  const toolCategories = new Set(extractObjectKeys(enforcerSource, 'TOOL_CATEGORIES'));
  const keywordMap = new Set(extractObjectKeys(enforcerSource, 'KEYWORD_FALLBACK_MAP'));

  // Switch case coverage
  const confirmationCases = new Set(extractSwitchCases(enforcerSource, '_buildConfirmationMessage'));
  const patternCases = new Set(extractSwitchCases(enforcerSource, '_getConfirmationPatterns'));
  const approvalMsgCases = new Set(extractSwitchCases(enforcerSource, '_buildToolApprovalMessage'));
  const genericActionMap = new Set(extractObjectKeys(enforcerSource, 'actionMap'));

  for (const tool of approvalTools) {
    // Only check tools that are actually registered
    if (!registeredTools.has(tool)) continue;

    const status = {};
    status.TOOL_APPROVAL_LABELS = approvalLabels.has(tool);
    status._getConfirmationPatterns = patternCases.has(tool);
    status._buildToolApprovalMessage = approvalMsgCases.has(tool);
    status._buildConfirmationMessage = confirmationCases.has(tool);

    const allGood = Object.values(status).every(v => v);
    if (allGood) {
      if (VERBOSE) {
        findings.push({
          severity: 'pass',
          message: `${tool} — full approval path coverage`,
        });
      }
    } else {
      const missing = Object.entries(status)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      findings.push({
        severity: 'warning',
        message: `${tool} — missing in: ${missing.join(', ')}`,
      });
    }
  }

  // Check SENSITIVE_TOOLS have full enforcer coverage
  for (const tool of sensitiveTools) {
    if (!registeredTools.has(tool)) continue;
    const hasCat = toolCategories.has(tool);
    const hasKw = keywordMap.has(tool);
    const hasConfirm = confirmationCases.has(tool);
    if (!hasCat || !hasKw || !hasConfirm) {
      const missing = [];
      if (!hasCat) missing.push('TOOL_CATEGORIES');
      if (!hasKw) missing.push('KEYWORD_FALLBACK_MAP');
      if (!hasConfirm) missing.push('_buildConfirmationMessage');
      findings.push({
        severity: 'warning',
        message: `${tool} (SENSITIVE) — missing in: ${missing.join(', ')}`,
      });
    }
  }

  return findings;
}

// ── Report Generation ───────────────────────────────────────────

function formatFindings(title, findings) {
  const lines = [];
  lines.push('');
  lines.push(c.bold(`━━━ ${title} ━━━`));
  lines.push('');

  let warnings = 0;
  let infos = 0;
  let passes = 0;

  for (const f of findings) {
    switch (f.severity) {
      case 'warning':
        lines.push(`  ${c.yellow('⚠')} ${f.message}`);
        warnings++;
        break;
      case 'info':
        lines.push(`  ${c.blue('ℹ')} ${f.message}`);
        infos++;
        break;
      case 'pass':
        lines.push(`  ${c.green('✓')} ${f.message}`);
        passes++;
        break;
    }
  }

  if (findings.length === 0) {
    lines.push(`  ${c.green('✓')} No findings`);
  }

  lines.push('');
  lines.push(c.dim(`  (${warnings} warnings, ${infos} info, ${passes} pass)`));
  return lines.join('\n');
}

function generateMarkdownReport(results) {
  const lines = [];
  lines.push('# Moltagent Wiring Audit Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  let totalWarnings = 0;
  let totalInfos = 0;

  for (const [title, findings] of Object.entries(results)) {
    lines.push(`## ${title}`);
    lines.push('');

    for (const f of findings) {
      const icon = f.severity === 'warning' ? '⚠' : f.severity === 'info' ? 'ℹ' : '✓';
      lines.push(`- ${icon} ${f.message}`);
      if (f.severity === 'warning') totalWarnings++;
      if (f.severity === 'info') totalInfos++;
    }

    if (findings.length === 0) {
      lines.push('- ✓ No findings');
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`**Summary:** ${totalWarnings} warnings, ${totalInfos} info items`);
  lines.push('');
  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  console.log(c.bold('\n╔══════════════════════════════════════════╗'));
  console.log(c.bold('║     MOLTAGENT WIRING AUDIT               ║'));
  console.log(c.bold('╚══════════════════════════════════════════╝\n'));

  const results = {};

  // Scanner 1
  console.log(c.dim('Running Scanner 1: Orphaned Client Methods...'));
  results['Scanner 1: Orphaned Client Methods'] = scanOrphanedMethods();

  // Scanner 2
  console.log(c.dim('Running Scanner 2: Unguarded Tools...'));
  results['Scanner 2: Unguarded Tools'] = scanUnguardedTools();

  // Scanner 3
  console.log(c.dim('Running Scanner 3: Inconsistent Error Handling...'));
  results['Scanner 3: Inconsistent Error Handling'] = scanErrorHandling();

  // Scanner 4
  console.log(c.dim('Running Scanner 4: SOUL.md ↔ Code Drift...'));
  results['Scanner 4: SOUL.md ↔ Code Drift'] = scanSoulDrift();

  // Scanner 5
  console.log(c.dim('Running Scanner 5: Tool Subset Gaps...'));
  results['Scanner 5: Tool Subset Gaps'] = scanSubsetGaps();

  // Scanner 6
  console.log(c.dim('Running Scanner 6: Approval Path Completeness...'));
  results['Scanner 6: Approval Path Completeness'] = scanApprovalPaths();

  console.log('');

  // Output
  if (JSON_OUTPUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const [title, findings] of Object.entries(results)) {
      console.log(formatFindings(title, findings));
    }
  }

  // Summary
  let totalWarnings = 0;
  let totalInfos = 0;
  for (const findings of Object.values(results)) {
    for (const f of findings) {
      if (f.severity === 'warning') totalWarnings++;
      if (f.severity === 'info') totalInfos++;
    }
  }

  console.log('');
  console.log(c.bold('━━━ SUMMARY ━━━'));
  console.log(`  Total warnings: ${totalWarnings > 0 ? c.yellow(totalWarnings) : c.green('0')}`);
  console.log(`  Total info:     ${totalInfos > 0 ? c.blue(totalInfos) : '0'}`);
  console.log('');

  // Write markdown report
  const reportPath = path.join(ROOT, CONFIG.reportOutputPath);
  const md = generateMarkdownReport(results);
  fs.writeFileSync(reportPath, md, 'utf-8');
  console.log(c.dim(`Report written to ${CONFIG.reportOutputPath}`));
  console.log('');

  // Exit code
  process.exit(totalWarnings > 0 ? 1 : 0);
}

main();
