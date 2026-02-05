# MoltAgent Session 7: Agent Self-Documentation
## Claude Code Implementation Brief

**Date:** 2026-02-06  
**Author:** Fu + Claude Opus (architecture)  
**Executor:** Claude Code  
**Estimated CCode time:** ~2 hours  
**Dependencies:** Sessions 1-6 complete  
**Position:** FINAL SESSION BEFORE LAUNCH GATE

---

## Context

When a user asks "What can you do?", the agent currently has no structured way to answer. It might hallucinate capabilities it doesn't have, or fail to mention things it can do.

**This session builds the capability registry** — a structured system that:

1. **Tracks what the agent can actually do** (installed skills, integrations, handlers)
2. **Generates accurate help responses** on demand
3. **Updates automatically** when capabilities change
4. **Provides `/help` and `/status` commands** in Talk

**Why this is the launch gate?** A concierge client's first interaction will be "What can you do?" — if the answer is wrong or vague, you've lost trust instantly.

**Scope:** This is NOT NC Collectives integration (that's optional, post-launch). This is a simple capability registry that powers accurate help responses.

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
 */
```

---

## Pre-Session Discovery

**Check what command handling exists:**

```bash
# 1. Check if Talk commands exist
grep -rn "\/help\|\/status\|command" /opt/moltagent/src/lib/*.js | head -30

# 2. Check MessageRouter or similar
ls -la /opt/moltagent/src/lib/message*.js /opt/moltagent/src/lib/*handler*.js 2>/dev/null

# 3. Check existing capabilities documentation
ls -la /opt/moltagent/src/lib/integrations/
cat /opt/moltagent/TOOLS.md 2>/dev/null | head -50

# 4. Check HeartbeatManager for command routing
grep -n "message\|command\|intent" /opt/moltagent/src/lib/heartbeat-manager.js | head -20

# 5. Check Talk client for message handling
grep -n "sendMessage\|handleMessage" /opt/moltagent/src/lib/talk*.js | head -20
```

Adjust implementation based on findings.

---

## Deliverables

| # | File | Est. Time | What It Does |
|---|------|-----------|-------------|
| 1 | `src/lib/capabilities/capability-registry.js` | 40 min | Central registry of agent capabilities |
| 2 | `src/lib/capabilities/help-generator.js` | 30 min | Generate help text from registry |
| 3 | `src/lib/capabilities/status-reporter.js` | 25 min | Generate status reports (health, providers) |
| 4 | `src/lib/capabilities/command-handler.js` | 25 min | Handle /help, /status, /capabilities commands |
| 5 | Heartbeat/bot.js integration | 15 min | Wire commands into message pipeline |
| 6 | Tests | 25 min | Unit tests for all modules |

---

## 1. Capability Registry

**File:** `src/lib/capabilities/capability-registry.js`

The registry is the single source of truth for what the agent can do.

```javascript
/**
 * Central registry of agent capabilities.
 * Powers help generation, status reports, and capability queries.
 */
class CapabilityRegistry {
  constructor() {
    // Core capabilities (always present)
    this.core = new Map();
    
    // Integrations (Deck, Calendar, etc.)
    this.integrations = new Map();
    
    // Skills (dynamic, from Skill Forge)
    this.skills = new Map();
    
    // Commands (slash commands)
    this.commands = new Map();
    
    // Provider status
    this.providers = new Map();
    
    this.initialized = false;
  }

  /**
   * Initialize the registry with built-in capabilities.
   */
  initialize() {
    if (this.initialized) return;

    // Register core capabilities
    this.registerCore('conversation', {
      name: 'General Conversation',
      description: 'Answer questions, help with tasks, and have conversations',
      examples: ['What is the capital of France?', 'Help me write an email'],
      alwaysAvailable: true,
    });

    this.registerCore('research', {
      name: 'Research & Analysis',
      description: 'Research topics, summarize information, analyze documents',
      examples: ['Research the latest AI trends', 'Summarize this document'],
      alwaysAvailable: true,
    });

    // Register built-in commands
    this.registerCommand('/help', {
      description: 'Show what I can do',
      usage: '/help [topic]',
      examples: ['/help', '/help calendar', '/help commands'],
    });

    this.registerCommand('/status', {
      description: 'Show system status and health',
      usage: '/status',
      examples: ['/status'],
    });

    this.registerCommand('/capabilities', {
      description: 'List all available capabilities',
      usage: '/capabilities',
      examples: ['/capabilities'],
    });

    this.initialized = true;
  }

  /**
   * Register a core capability.
   */
  registerCore(id, capability) {
    this.core.set(id, {
      id,
      type: 'core',
      ...capability,
      registeredAt: new Date().toISOString(),
    });
  }

  /**
   * Register an integration (Deck, Calendar, etc.).
   */
  registerIntegration(id, integration) {
    this.integrations.set(id, {
      id,
      type: 'integration',
      status: 'active',
      ...integration,
      registeredAt: new Date().toISOString(),
    });
  }

  /**
   * Register a skill (from Skill Forge or manual).
   */
  registerSkill(id, skill) {
    this.skills.set(id, {
      id,
      type: 'skill',
      status: 'active',
      ...skill,
      registeredAt: new Date().toISOString(),
    });
  }

  /**
   * Register a slash command.
   */
  registerCommand(command, definition) {
    this.commands.set(command.toLowerCase(), {
      command,
      ...definition,
    });
  }

  /**
   * Update provider status.
   */
  setProviderStatus(providerId, status) {
    this.providers.set(providerId, {
      id: providerId,
      ...status,
      lastChecked: new Date().toISOString(),
    });
  }

  /**
   * Mark an integration as unavailable.
   */
  setIntegrationStatus(id, status, reason = null) {
    const integration = this.integrations.get(id);
    if (integration) {
      integration.status = status;
      integration.statusReason = reason;
      integration.statusUpdated = new Date().toISOString();
    }
  }

  /**
   * Get all capabilities grouped by type.
   */
  getAllCapabilities() {
    return {
      core: Array.from(this.core.values()),
      integrations: Array.from(this.integrations.values()).filter(i => i.status === 'active'),
      skills: Array.from(this.skills.values()).filter(s => s.status === 'active'),
      commands: Array.from(this.commands.values()),
    };
  }

  /**
   * Search capabilities by keyword.
   */
  search(query) {
    const q = query.toLowerCase();
    const results = [];

    const searchIn = (items) => {
      for (const item of items) {
        const searchable = [
          item.name,
          item.description,
          ...(item.examples || []),
          ...(item.keywords || []),
        ].join(' ').toLowerCase();

        if (searchable.includes(q)) {
          results.push(item);
        }
      }
    };

    searchIn(this.core.values());
    searchIn(this.integrations.values());
    searchIn(this.skills.values());
    searchIn(this.commands.values());

    return results;
  }

  /**
   * Get a specific command definition.
   */
  getCommand(command) {
    return this.commands.get(command.toLowerCase());
  }

  /**
   * Check if a capability exists.
   */
  hasCapability(id) {
    return this.core.has(id) || 
           this.integrations.has(id) || 
           this.skills.has(id);
  }

  /**
   * Get capability by ID (any type).
   */
  getCapability(id) {
    return this.core.get(id) || 
           this.integrations.get(id) || 
           this.skills.get(id);
  }

  /**
   * Get all provider statuses.
   */
  getProviderStatuses() {
    return Array.from(this.providers.values());
  }

  /**
   * Export registry as JSON (for persistence or debugging).
   */
  toJSON() {
    return {
      core: Array.from(this.core.entries()),
      integrations: Array.from(this.integrations.entries()),
      skills: Array.from(this.skills.entries()),
      commands: Array.from(this.commands.entries()),
      providers: Array.from(this.providers.entries()),
      exportedAt: new Date().toISOString(),
    };
  }
}

module.exports = { CapabilityRegistry };
```

---

## 2. Help Generator

**File:** `src/lib/capabilities/help-generator.js`

Generates human-readable help text from the registry.

```javascript
/**
 * Generates help text from the capability registry.
 */
class HelpGenerator {
  /**
   * @param {CapabilityRegistry} registry
   */
  constructor(registry) {
    this.registry = registry;
  }

  /**
   * Generate main help response.
   * @returns {string}
   */
  generateMainHelp() {
    const caps = this.registry.getAllCapabilities();
    const lines = [];

    lines.push('# 🤖 What I Can Do\n');

    // Core capabilities
    if (caps.core.length > 0) {
      lines.push('## 💬 General\n');
      for (const cap of caps.core) {
        lines.push(`**${cap.name}**`);
        lines.push(`${cap.description}\n`);
      }
    }

    // Integrations
    if (caps.integrations.length > 0) {
      lines.push('## 🔗 Integrations\n');
      for (const int of caps.integrations) {
        const emoji = int.emoji || '•';
        lines.push(`**${emoji} ${int.name}**`);
        lines.push(`${int.description}`);
        if (int.examples && int.examples.length > 0) {
          lines.push(`Try: "${int.examples[0]}"\n`);
        } else {
          lines.push('');
        }
      }
    }

    // Skills
    if (caps.skills.length > 0) {
      lines.push('## ⚡ Skills\n');
      for (const skill of caps.skills) {
        const emoji = skill.emoji || '•';
        lines.push(`**${emoji} ${skill.name}**`);
        lines.push(`${skill.description}\n`);
      }
    }

    // Commands
    lines.push('## 📝 Commands\n');
    for (const cmd of caps.commands) {
      lines.push(`\`${cmd.command}\` — ${cmd.description}`);
    }

    lines.push('\n---');
    lines.push('*Ask me anything, or use `/help [topic]` for more details.*');

    return lines.join('\n');
  }

  /**
   * Generate help for a specific topic.
   * @param {string} topic
   * @returns {string}
   */
  generateTopicHelp(topic) {
    // Check if it's a command
    if (topic.startsWith('/')) {
      const cmd = this.registry.getCommand(topic);
      if (cmd) {
        return this.formatCommandHelp(cmd);
      }
    }

    // Search capabilities
    const results = this.registry.search(topic);

    if (results.length === 0) {
      return `I don't have specific help for "${topic}". Try \`/help\` to see what I can do.`;
    }

    if (results.length === 1) {
      return this.formatCapabilityHelp(results[0]);
    }

    // Multiple results
    const lines = [`Found ${results.length} matches for "${topic}":\n`];
    for (const result of results.slice(0, 5)) {
      lines.push(`• **${result.name || result.command}** — ${result.description}`);
    }
    if (results.length > 5) {
      lines.push(`\n...and ${results.length - 5} more.`);
    }
    return lines.join('\n');
  }

  /**
   * Format detailed help for a capability.
   * @private
   */
  formatCapabilityHelp(cap) {
    const lines = [];
    const emoji = cap.emoji || '📌';

    lines.push(`# ${emoji} ${cap.name || cap.command}\n`);
    lines.push(cap.description);

    if (cap.usage) {
      lines.push(`\n**Usage:** \`${cap.usage}\``);
    }

    if (cap.examples && cap.examples.length > 0) {
      lines.push('\n**Examples:**');
      for (const ex of cap.examples) {
        lines.push(`• "${ex}"`);
      }
    }

    if (cap.operations && cap.operations.length > 0) {
      lines.push('\n**Operations:**');
      for (const op of cap.operations) {
        lines.push(`• ${op}`);
      }
    }

    if (cap.status && cap.status !== 'active') {
      lines.push(`\n⚠️ *Status: ${cap.status}*`);
      if (cap.statusReason) {
        lines.push(`*Reason: ${cap.statusReason}*`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format help for a command.
   * @private
   */
  formatCommandHelp(cmd) {
    const lines = [];

    lines.push(`# ${cmd.command}\n`);
    lines.push(cmd.description);

    if (cmd.usage) {
      lines.push(`\n**Usage:** \`${cmd.usage}\``);
    }

    if (cmd.examples && cmd.examples.length > 0) {
      lines.push('\n**Examples:**');
      for (const ex of cmd.examples) {
        lines.push(`• \`${ex}\``);
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate a short capabilities summary (for context injection).
   * @returns {string}
   */
  generateSummary() {
    const caps = this.registry.getAllCapabilities();
    const parts = [];

    if (caps.integrations.length > 0) {
      const names = caps.integrations.map(i => i.name).join(', ');
      parts.push(`Integrations: ${names}`);
    }

    if (caps.skills.length > 0) {
      const names = caps.skills.map(s => s.name).join(', ');
      parts.push(`Skills: ${names}`);
    }

    if (caps.commands.length > 0) {
      const cmds = caps.commands.map(c => c.command).join(', ');
      parts.push(`Commands: ${cmds}`);
    }

    return parts.join('. ');
  }
}

module.exports = { HelpGenerator };
```

---

## 3. Status Reporter

**File:** `src/lib/capabilities/status-reporter.js`

Generates system status reports.

```javascript
/**
 * Generates status reports for the agent.
 */
class StatusReporter {
  /**
   * @param {CapabilityRegistry} registry
   * @param {Object} options
   * @param {Object} [options.heartbeat] - HeartbeatManager for runtime stats
   * @param {Object} [options.knowledgeBoard] - KnowledgeBoard for knowledge stats
   */
  constructor(registry, options = {}) {
    this.registry = registry;
    this.heartbeat = options.heartbeat;
    this.knowledgeBoard = options.knowledgeBoard;
    this.startTime = new Date();
  }

  /**
   * Generate full status report.
   * @returns {Promise<string>}
   */
  async generateStatus() {
    const lines = [];

    lines.push('# 📊 MoltAgent Status\n');

    // Uptime
    const uptime = this.formatUptime(Date.now() - this.startTime.getTime());
    lines.push(`**Uptime:** ${uptime}`);
    lines.push(`**Started:** ${this.startTime.toLocaleString()}\n`);

    // Provider status
    lines.push('## 🔌 Providers\n');
    const providers = this.registry.getProviderStatuses();
    if (providers.length === 0) {
      lines.push('No provider status available.\n');
    } else {
      for (const provider of providers) {
        const status = provider.available ? '✅' : '❌';
        const latency = provider.latencyMs ? ` (${provider.latencyMs}ms)` : '';
        lines.push(`${status} **${provider.id}**${latency}`);
        if (!provider.available && provider.error) {
          lines.push(`   └─ ${provider.error}`);
        }
      }
      lines.push('');
    }

    // Integrations status
    lines.push('## 🔗 Integrations\n');
    const caps = this.registry.getAllCapabilities();
    if (caps.integrations.length === 0) {
      lines.push('No integrations configured.\n');
    } else {
      for (const int of caps.integrations) {
        const status = int.status === 'active' ? '✅' : '⚠️';
        lines.push(`${status} **${int.name}** — ${int.status}`);
        if (int.statusReason) {
          lines.push(`   └─ ${int.statusReason}`);
        }
      }
      lines.push('');
    }

    // Skills
    if (caps.skills.length > 0) {
      lines.push('## ⚡ Skills\n');
      for (const skill of caps.skills) {
        const status = skill.status === 'active' ? '✅' : '⚠️';
        lines.push(`${status} **${skill.name}**`);
      }
      lines.push('');
    }

    // Knowledge stats
    if (this.knowledgeBoard) {
      try {
        const kbStatus = await this.knowledgeBoard.getStatus();
        lines.push('## 🧠 Knowledge\n');
        for (const [stack, count] of Object.entries(kbStatus.stacks)) {
          lines.push(`• ${stack}: ${count} items`);
        }
        lines.push('');
      } catch (e) {
        // Knowledge board not available
      }
    }

    // Heartbeat stats
    if (this.heartbeat && this.heartbeat.stats) {
      lines.push('## 💓 Activity\n');
      const stats = this.heartbeat.stats;
      lines.push(`• Tasks processed: ${stats.tasksProcessed || 0}`);
      lines.push(`• Messages handled: ${stats.messagesHandled || 0}`);
      lines.push(`• Last heartbeat: ${stats.lastHeartbeat || 'Never'}`);
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Generated ${new Date().toLocaleString()}*`);

    return lines.join('\n');
  }

  /**
   * Generate a short health check response.
   * @returns {Object}
   */
  getHealthCheck() {
    const providers = this.registry.getProviderStatuses();
    const allProvidersOk = providers.every(p => p.available !== false);

    const caps = this.registry.getAllCapabilities();
    const allIntegrationsOk = caps.integrations.every(i => i.status === 'active');

    return {
      healthy: allProvidersOk && allIntegrationsOk,
      uptime: Date.now() - this.startTime.getTime(),
      providers: providers.length,
      providersHealthy: providers.filter(p => p.available !== false).length,
      integrations: caps.integrations.length,
      integrationsHealthy: caps.integrations.filter(i => i.status === 'active').length,
      skills: caps.skills.length,
    };
  }

  /**
   * Format milliseconds as human-readable uptime.
   * @private
   */
  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }
}

module.exports = { StatusReporter };
```

---

## 4. Command Handler

**File:** `src/lib/capabilities/command-handler.js`

Routes slash commands to appropriate handlers.

```javascript
/**
 * Handles slash commands in Talk messages.
 */
class CommandHandler {
  /**
   * @param {Object} options
   * @param {CapabilityRegistry} options.registry
   * @param {HelpGenerator} options.helpGenerator
   * @param {StatusReporter} options.statusReporter
   */
  constructor({ registry, helpGenerator, statusReporter }) {
    this.registry = registry;
    this.help = helpGenerator;
    this.status = statusReporter;
  }

  /**
   * Check if a message is a command.
   * @param {string} message
   * @returns {boolean}
   */
  isCommand(message) {
    return message.trim().startsWith('/');
  }

  /**
   * Parse a command from a message.
   * @param {string} message
   * @returns {{ command: string, args: string[] } | null}
   */
  parseCommand(message) {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) return null;

    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    return { command, args };
  }

  /**
   * Handle a command and return the response.
   * @param {string} message
   * @param {Object} context - { roomToken, userId }
   * @returns {Promise<{ handled: boolean, response?: string }>}
   */
  async handle(message, context = {}) {
    const parsed = this.parseCommand(message);
    if (!parsed) {
      return { handled: false };
    }

    const { command, args } = parsed;

    switch (command) {
      case '/help':
        return {
          handled: true,
          response: args.length > 0
            ? this.help.generateTopicHelp(args.join(' '))
            : this.help.generateMainHelp(),
        };

      case '/status':
        return {
          handled: true,
          response: await this.status.generateStatus(),
        };

      case '/capabilities':
      case '/caps':
        return {
          handled: true,
          response: this.generateCapabilitiesList(),
        };

      case '/health':
        const health = this.status.getHealthCheck();
        return {
          handled: true,
          response: health.healthy
            ? `✅ All systems healthy. Uptime: ${this.status.formatUptime(health.uptime)}`
            : `⚠️ Some issues detected. Use \`/status\` for details.`,
        };

      default:
        // Check if it's a registered command
        const cmdDef = this.registry.getCommand(command);
        if (cmdDef && cmdDef.handler) {
          try {
            const result = await cmdDef.handler(args, context);
            return { handled: true, response: result };
          } catch (error) {
            return {
              handled: true,
              response: `❌ Command failed: ${error.message}`,
            };
          }
        }

        // Unknown command
        return {
          handled: true,
          response: `Unknown command: \`${command}\`. Try \`/help\` to see available commands.`,
        };
    }
  }

  /**
   * Generate a simple capabilities list.
   * @private
   */
  generateCapabilitiesList() {
    const caps = this.registry.getAllCapabilities();
    const lines = ['# Available Capabilities\n'];

    // Count by type
    lines.push(`• **Core:** ${caps.core.length} capabilities`);
    lines.push(`• **Integrations:** ${caps.integrations.length} active`);
    lines.push(`• **Skills:** ${caps.skills.length} installed`);
    lines.push(`• **Commands:** ${caps.commands.length} available`);

    lines.push('\nUse `/help` for details on each capability.');

    return lines.join('\n');
  }
}

module.exports = { CommandHandler };
```

---

## 5. Module Exports

**File:** `src/lib/capabilities/index.js`

```javascript
/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const { CapabilityRegistry } = require('./capability-registry');
const { HelpGenerator } = require('./help-generator');
const { StatusReporter } = require('./status-reporter');
const { CommandHandler } = require('./command-handler');

module.exports = {
  CapabilityRegistry,
  HelpGenerator,
  StatusReporter,
  CommandHandler,
};
```

---

## 6. Integration with bot.js

**Update:** `src/bot.js` or equivalent

```javascript
const {
  CapabilityRegistry,
  HelpGenerator,
  StatusReporter,
  CommandHandler,
} = require('./lib/capabilities');

// Initialize capability registry
const capabilityRegistry = new CapabilityRegistry();
capabilityRegistry.initialize();

// Register integrations based on what's configured
if (config.deck?.enabled !== false) {
  capabilityRegistry.registerIntegration('deck', {
    name: 'Task Management (Deck)',
    emoji: '📋',
    description: 'Create, view, and manage tasks on Kanban boards',
    examples: [
      'Show my tasks',
      'Create a task to review the proposal',
      'Move "Design review" to Done',
    ],
    operations: ['List boards', 'List tasks', 'Create task', 'Move task', 'Complete task'],
  });
}

if (config.calendar?.enabled !== false) {
  capabilityRegistry.registerIntegration('calendar', {
    name: 'Calendar',
    emoji: '📅',
    description: 'View and manage calendar events',
    examples: [
      "What's on my calendar today?",
      'Schedule a meeting tomorrow at 2pm',
      'Find a free slot this week',
    ],
    operations: ['View events', 'Create events', 'Find free time', 'Check conflicts'],
  });
}

// Register knowledge integration (from Session 6)
capabilityRegistry.registerIntegration('knowledge', {
  name: 'Learning & Memory',
  emoji: '🧠',
  description: 'Remember what I learn and track uncertain information',
  examples: [
    'Remember that John leads Q3',
    'What do you know about the project?',
  ],
  operations: ['Learn facts', 'Track uncertainty', 'Verify knowledge'],
});

// Initialize help and status generators
const helpGenerator = new HelpGenerator(capabilityRegistry);
const statusReporter = new StatusReporter(capabilityRegistry, {
  heartbeat,
  knowledgeBoard,
});
const commandHandler = new CommandHandler({
  registry: capabilityRegistry,
  helpGenerator,
  statusReporter,
});

// Update provider status periodically (in heartbeat)
// Example: After checking Ollama
capabilityRegistry.setProviderStatus('ollama', {
  available: true,
  latencyMs: 150,
  model: 'deepseek-r1',
});

// Example: After checking Claude
capabilityRegistry.setProviderStatus('claude', {
  available: true,
  latencyMs: 800,
  model: 'claude-sonnet-4-20250514',
});
```

---

## 7. Message Pipeline Integration

**Update:** Message handling in HeartbeatManager or MessageRouter

```javascript
// In message processing:
async handleIncomingMessage(message, context) {
  // Check for commands first
  if (commandHandler.isCommand(message)) {
    const result = await commandHandler.handle(message, context);
    if (result.handled) {
      await this.talkClient.sendMessage(context.roomToken, result.response);
      return;
    }
  }

  // Not a command, proceed with normal processing...
  // ... existing message handling ...
}
```

---

## 8. Test Cases

**File:** `test/unit/capabilities/capability-registry.test.js`

```javascript
describe('CapabilityRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new CapabilityRegistry();
  });

  describe('initialize()', () => {
    test('registers core capabilities', () => {
      registry.initialize();
      expect(registry.core.size).toBeGreaterThan(0);
      expect(registry.hasCapability('conversation')).toBe(true);
    });

    test('registers built-in commands', () => {
      registry.initialize();
      expect(registry.getCommand('/help')).toBeDefined();
      expect(registry.getCommand('/status')).toBeDefined();
    });

    test('is idempotent', () => {
      registry.initialize();
      const coreSizeBefore = registry.core.size;
      registry.initialize();
      expect(registry.core.size).toBe(coreSizeBefore);
    });
  });

  describe('registerIntegration()', () => {
    test('adds integration to registry', () => {
      registry.registerIntegration('deck', {
        name: 'Deck',
        description: 'Task management',
      });

      expect(registry.integrations.has('deck')).toBe(true);
      expect(registry.hasCapability('deck')).toBe(true);
    });
  });

  describe('search()', () => {
    test('finds capabilities by keyword', () => {
      registry.initialize();
      registry.registerIntegration('calendar', {
        name: 'Calendar',
        description: 'Manage events and meetings',
        keywords: ['schedule', 'appointment'],
      });

      const results = registry.search('meeting');
      expect(results.some(r => r.name === 'Calendar')).toBe(true);
    });

    test('returns empty array for no matches', () => {
      registry.initialize();
      const results = registry.search('xyznonexistent');
      expect(results).toHaveLength(0);
    });
  });

  describe('setProviderStatus()', () => {
    test('tracks provider status', () => {
      registry.setProviderStatus('ollama', {
        available: true,
        latencyMs: 100,
      });

      const statuses = registry.getProviderStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].available).toBe(true);
    });
  });
});
```

**File:** `test/unit/capabilities/command-handler.test.js`

```javascript
describe('CommandHandler', () => {
  let handler;
  let mockRegistry;
  let mockHelpGenerator;
  let mockStatusReporter;

  beforeEach(() => {
    mockRegistry = {
      getCommand: jest.fn(),
      getAllCapabilities: jest.fn().mockReturnValue({
        core: [], integrations: [], skills: [], commands: [],
      }),
    };
    mockHelpGenerator = {
      generateMainHelp: jest.fn().mockReturnValue('# Help'),
      generateTopicHelp: jest.fn().mockReturnValue('Topic help'),
    };
    mockStatusReporter = {
      generateStatus: jest.fn().mockResolvedValue('# Status'),
      getHealthCheck: jest.fn().mockReturnValue({ healthy: true, uptime: 1000 }),
      formatUptime: jest.fn().mockReturnValue('1s'),
    };

    handler = new CommandHandler({
      registry: mockRegistry,
      helpGenerator: mockHelpGenerator,
      statusReporter: mockStatusReporter,
    });
  });

  describe('isCommand()', () => {
    test('returns true for commands', () => {
      expect(handler.isCommand('/help')).toBe(true);
      expect(handler.isCommand('/status')).toBe(true);
    });

    test('returns false for non-commands', () => {
      expect(handler.isCommand('hello')).toBe(false);
      expect(handler.isCommand('what can you do?')).toBe(false);
    });
  });

  describe('handle()', () => {
    test('handles /help', async () => {
      const result = await handler.handle('/help');
      expect(result.handled).toBe(true);
      expect(mockHelpGenerator.generateMainHelp).toHaveBeenCalled();
    });

    test('handles /help [topic]', async () => {
      const result = await handler.handle('/help calendar');
      expect(result.handled).toBe(true);
      expect(mockHelpGenerator.generateTopicHelp).toHaveBeenCalledWith('calendar');
    });

    test('handles /status', async () => {
      const result = await handler.handle('/status');
      expect(result.handled).toBe(true);
      expect(mockStatusReporter.generateStatus).toHaveBeenCalled();
    });

    test('returns unknown command message', async () => {
      mockRegistry.getCommand.mockReturnValue(null);
      const result = await handler.handle('/unknowncommand');
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Unknown command');
    });
  });
});
```

---

## 9. Exit Criteria

Before calling this session done:

**CapabilityRegistry:**
- [ ] `initialize()` registers core capabilities and commands
- [ ] `registerIntegration()` / `registerSkill()` work
- [ ] `search()` finds capabilities by keyword
- [ ] `setProviderStatus()` tracks provider health
- [ ] `getAllCapabilities()` returns grouped capabilities

**HelpGenerator:**
- [ ] `generateMainHelp()` lists all capabilities
- [ ] `generateTopicHelp()` gives detailed help for specific topics
- [ ] `generateSummary()` gives brief overview for context injection

**StatusReporter:**
- [ ] `generateStatus()` shows providers, integrations, uptime
- [ ] `getHealthCheck()` returns quick health summary

**CommandHandler:**
- [ ] `/help` works (with and without topic)
- [ ] `/status` works
- [ ] `/capabilities` works
- [ ] Unknown commands get helpful error

**Integration:**
- [ ] Commands routed in message pipeline
- [ ] Integrations registered on startup
- [ ] Provider status updated during heartbeat

**Tests:**
- [ ] All capability tests pass
- [ ] No real API calls in tests
- [ ] `npm test` passes (1300+ tests)
- [ ] ESLint clean
- [ ] AGPL headers on all new files

---

## 10. What This Enables

After this session:

```
User: What can you do?
Agent: # 🤖 What I Can Do

## 💬 General
**General Conversation** — Answer questions, help with tasks...

## 🔗 Integrations
**📋 Task Management (Deck)** — Create, view, manage tasks...
**📅 Calendar** — View and manage calendar events...
**🧠 Learning & Memory** — Remember what I learn...

## 📝 Commands
`/help` — Show what I can do
`/status` — Show system status and health
...

User: /status
Agent: # 📊 MoltAgent Status
**Uptime:** 2h 15m
## 🔌 Providers
✅ **ollama** (150ms)
✅ **claude** (800ms)
## 🔗 Integrations
✅ **Task Management** — active
✅ **Calendar** — active
...
```

---

## 11. What's NOT in Scope

These are deferred:

- NC Collectives app integration (wiki pages)
- Automatic skill discovery from OpenClaw
- Capability versioning
- Remote capability announcements (federation)

---

## 12. What Comes Next

**── LAUNCH GATE REACHED ──**

After Session 7, you have:
- ✅ Security layer (Sessions 1-4)
- ✅ Calendar integration (Session 5)
- ✅ Agent memory (Session 6)
- ✅ Self-documentation (Session 7)

**Ready for first concierge client.**

**Post-launch sessions:**
- Session 8+: Skill Forge (template engine, Talk conversation, catalog)
- Phase 6+: NC Forms, Generic Builder, Email, full Knowledge System

---

*Built for MoltAgent Session 7. An agent that knows what it can do is an agent users can trust.*
