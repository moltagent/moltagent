/**
 * Moltagent Output Verifier
 *
 * Security layer that checks LLM outputs before execution.
 * Blocks suspicious patterns that could indicate:
 * - Credential exfiltration attempts
 * - Dangerous shell commands
 * - Code injection
 * - Data exfiltration via URLs
 *
 * @module output-verifier
 * @version 1.0.0
 */

/**
 * Custom error for output verification failures
 */
class OutputVerificationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OutputVerificationError';
    this.code = 'OUTPUT_BLOCKED';
    this.category = details.category;
    this.severity = details.severity;
    this.pattern = details.pattern;
    this.match = details.match;
  }
}

class OutputVerifier {
  /**
   * @param {Object} config
   * @param {Function} [config.auditLog] - Audit logging function
   * @param {boolean} [config.strictMode=false] - Block on any suspicion vs. high confidence only
   * @param {string[]} [config.allowedDomains] - Domains allowed in URLs
   * @param {RegExp[]} [config.customPatterns] - Additional patterns to block
   * @param {RegExp[]} [config.allowPatterns] - Patterns to allow (override blocks)
   */
  constructor(config = {}) {
    this.auditLog = config.auditLog || (async () => {});
    this.strictMode = config.strictMode || false;
    this.allowedDomains = config.allowedDomains || [];
    this.customPatterns = config.customPatterns || [];
    this.allowPatterns = config.allowPatterns || [];

    // Statistics
    this.stats = {
      totalChecks: 0,
      blocked: 0,
      allowed: 0,
      byCategory: {}
    };

    // Initialize pattern categories
    this._initializePatterns();
  }

  /**
   * Initialize detection patterns by category
   * @private
   */
  _initializePatterns() {
    this.patterns = {
      // Shell injection / dangerous commands
      shellInjection: {
        severity: 'critical',
        patterns: [
          { regex: /curl\s+[^\n]*\|\s*(ba)?sh/i, desc: 'Pipe curl to shell' },
          { regex: /wget\s+[^\n]*\|\s*(ba)?sh/i, desc: 'Pipe wget to shell' },
          { regex: /\|\s*(ba)?sh\s*$/im, desc: 'Pipe to shell' },
          { regex: /(?<!`)`(?!`)(?=\s*(?:curl|wget|rm|chmod|chown|cat|echo|ls|find|grep|awk|sed|bash|sh|python|perl|ruby|node|nc|ncat|dd|mkfs|eval|whoami|id|uname|hostname|env|printenv|pwd)\b)[^`]+`(?!`)/, desc: 'Backtick command substitution' },
          { regex: /\$\([^)]+\)/, desc: 'Command substitution' },
          { regex: /;\s*(rm|chmod|chown|mkfs|dd)\s/i, desc: 'Chained dangerous command' },
        ]
      },

      // Destructive commands
      destructive: {
        severity: 'critical',
        patterns: [
          { regex: /rm\s+(-[rf]+\s+)*[\/~]/, desc: 'Remove from root or home' },
          { regex: /rm\s+-rf\s/i, desc: 'Recursive force delete' },
          { regex: /mkfs\./i, desc: 'Format filesystem' },
          { regex: /dd\s+if=.*of=\/dev/i, desc: 'Write to device' },
          { regex: />\s*\/dev\/[sh]d[a-z]/i, desc: 'Write to disk device' },
          { regex: /chmod\s+777/i, desc: 'World-writable permissions' },
          { regex: /chmod\s+[0-7]*[67][0-7]{2}/i, desc: 'Dangerous permissions' },
        ]
      },

      // System path writes
      systemPaths: {
        severity: 'high',
        patterns: [
          { regex: />\s*\/etc\//i, desc: 'Write to /etc' },
          { regex: />\s*\/var\//i, desc: 'Write to /var' },
          { regex: />\s*\/root\//i, desc: 'Write to /root' },
          { regex: />\s*\/usr\//i, desc: 'Write to /usr' },
          { regex: />\s*\/bin\//i, desc: 'Write to /bin' },
          { regex: />\s*\/sbin\//i, desc: 'Write to /sbin' },
          { regex: />\s*~\/\.bashrc/i, desc: 'Write to bashrc' },
          { regex: />\s*~\/\.profile/i, desc: 'Write to profile' },
          { regex: />\s*~\/\.ssh\//i, desc: 'Write to SSH config' },
        ]
      },

      // Code execution
      codeExecution: {
        severity: 'high',
        patterns: [
          { regex: /eval\s*\(/i, desc: 'eval() call' },
          { regex: /new\s+Function\s*\(/i, desc: 'Function constructor' },
          { regex: /exec\s*\(/i, desc: 'exec() call' },
          { regex: /child_process/i, desc: 'child_process module' },
          { regex: /spawn\s*\(/i, desc: 'spawn() call' },
          { regex: /execSync\s*\(/i, desc: 'execSync() call' },
        ]
      },

      // Credential patterns (potential exfiltration)
      credentialPatterns: {
        severity: 'critical',
        patterns: [
          { regex: /sk-[a-zA-Z0-9-_]{20,}/i, desc: 'OpenAI API key pattern' },
          { regex: /sk-proj-[a-zA-Z0-9-_]{20,}/i, desc: 'OpenAI project key pattern' },
          { regex: /sk-ant-[a-zA-Z0-9-_]{20,}/i, desc: 'Anthropic API key pattern' },
          { regex: /ghp_[a-zA-Z0-9]{36}/i, desc: 'GitHub personal token' },
          { regex: /gho_[a-zA-Z0-9]{36}/i, desc: 'GitHub OAuth token' },
          { regex: /glpat-[a-zA-Z0-9-_]{20,}/i, desc: 'GitLab token' },
          { regex: /AKIA[0-9A-Z]{16}/i, desc: 'AWS access key' },
          { regex: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/i, desc: 'JWT token' },
          { regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i, desc: 'Private key' },
          { regex: /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----/i, desc: 'SSH private key' },
        ]
      },

      // URL-based exfiltration
      urlExfiltration: {
        severity: 'high',
        patterns: [
          { regex: /https?:\/\/[^\s]*[?&](password|secret|token|apikey|api_key|auth)=/i, desc: 'Sensitive param in URL' },
          { regex: /https?:\/\/[^\s]*[?&][^=]*=(sk-[a-zA-Z0-9]{10,}|ghp_|AKIA)/i, desc: 'Credential value in URL param' },
          { regex: /https?:\/\/[^\s]*#[^\s]*base64/i, desc: 'Base64 in URL fragment' },
          { regex: /webhook\.site/i, desc: 'Webhook.site (data exfil service)' },
          { regex: /requestbin\./i, desc: 'RequestBin (data exfil service)' },
          { regex: /ngrok\.io/i, desc: 'Ngrok tunnel' },
          { regex: /burpcollaborator/i, desc: 'Burp Collaborator' },
          { regex: /interact\.sh/i, desc: 'Interactsh (data exfil service)' },
          { regex: /oastify\.com/i, desc: 'OAST service' },
        ]
      },

      // Base64 encoded suspicious content
      encodedContent: {
        severity: 'medium',
        patterns: [
          { regex: /base64\s*-d/i, desc: 'Base64 decode command' },
          { regex: /atob\s*\(/i, desc: 'JavaScript base64 decode' },
          { regex: /Buffer\.from\([^)]+,\s*['"]base64['"]\)/i, desc: 'Node.js base64 decode' },
        ]
      },

      // Network exfiltration
      networkExfil: {
        severity: 'high',
        patterns: [
          { regex: /nc\s+-[^\s]*\s+\d+\.\d+\.\d+\.\d+/i, desc: 'Netcat to IP' },
          { regex: /ncat\s+/i, desc: 'Ncat command' },
          { regex: /socat\s+/i, desc: 'Socat command' },
          { regex: /telnet\s+\d+\.\d+\.\d+\.\d+/i, desc: 'Telnet to IP' },
          { regex: /curl\s+.*-d\s+.*@/i, desc: 'Curl POST file' },
          { regex: /curl\s+.*--data-binary\s+@/i, desc: 'Curl binary POST file' },
        ]
      },

      // SQL injection (if LLM generates SQL)
      sqlInjection: {
        severity: 'medium',
        patterns: [
          { regex: /;\s*DROP\s+TABLE/i, desc: 'DROP TABLE injection' },
          { regex: /;\s*DELETE\s+FROM/i, desc: 'DELETE injection' },
          { regex: /UNION\s+SELECT\s+/i, desc: 'UNION SELECT injection' },
          { regex: /OR\s+['"]?1['"]?\s*=\s*['"]?1/i, desc: 'OR 1=1 injection' },
          { regex: /--\s*$/m, desc: 'SQL comment terminator' },
        ]
      },

      // Prompt injection indicators (LLM trying to break out)
      promptInjection: {
        severity: 'medium',
        patterns: [
          { regex: /ignore\s+(previous|all|above)\s+instructions/i, desc: 'Instruction override attempt' },
          { regex: /disregard\s+(previous|all|above)/i, desc: 'Disregard instructions' },
          { regex: /you\s+are\s+now\s+(a|an)\s+/i, desc: 'Role reassignment attempt' },
          { regex: /\[SYSTEM\]/i, desc: 'Fake system message' },
          { regex: /###\s*(SYSTEM|INSTRUCTION)/i, desc: 'Markdown system message' },
        ]
      }
    };
  }

  /**
   * Verify an output is safe
   * @param {string} output - The LLM output to check
   * @param {Object} [context] - Additional context
   * @param {string} [context.task] - The task type
   * @param {string} [context.expectedType] - Expected output type
   * @returns {Object} - { safe: boolean, blocked?: Object, warnings?: Object[] }
   */
  async verify(output, context = {}) {
    this.stats.totalChecks++;

    if (!output || typeof output !== 'string') {
      this.stats.allowed++;
      return { safe: true };
    }

    const result = {
      safe: true,
      warnings: [],
      blocked: null
    };

    // Check allow patterns first (whitelist)
    for (const pattern of this.allowPatterns) {
      if (pattern.test(output)) {
        this.stats.allowed++;
        return { safe: true, whitelisted: true };
      }
    }

    // Check each category
    for (const [category, config] of Object.entries(this.patterns)) {
      for (const { regex, desc } of config.patterns) {
        const match = output.match(regex);
        if (match) {
          const finding = {
            category,
            severity: config.severity,
            description: desc,
            pattern: regex.toString(),
            match: match[0].substring(0, 100), // Truncate for logging
            position: match.index
          };

          if (config.severity === 'critical' || config.severity === 'high') {
            // Block immediately
            result.safe = false;
            result.blocked = finding;

            this.stats.blocked++;
            this.stats.byCategory[category] = (this.stats.byCategory[category] || 0) + 1;

            await this.auditLog('output_blocked', {
              ...finding,
              task: context.task,
              outputLength: output.length,
              outputPreview: output.substring(0, 200)
            });

            return result;
          } else if (this.strictMode) {
            // In strict mode, medium severity also blocks
            result.safe = false;
            result.blocked = finding;

            this.stats.blocked++;
            this.stats.byCategory[category] = (this.stats.byCategory[category] || 0) + 1;

            await this.auditLog('output_blocked_strict', {
              ...finding,
              task: context.task
            });

            return result;
          } else {
            // Medium severity = warning only
            result.warnings.push(finding);

            await this.auditLog('output_warning', {
              ...finding,
              task: context.task
            });
          }
        }
      }
    }

    // Check custom patterns
    for (const pattern of this.customPatterns) {
      if (pattern.test(output)) {
        result.safe = false;
        result.blocked = {
          category: 'custom',
          severity: 'high',
          description: 'Custom pattern match',
          pattern: pattern.toString()
        };

        this.stats.blocked++;

        await this.auditLog('output_blocked_custom', {
          pattern: pattern.toString(),
          task: context.task
        });

        return result;
      }
    }

    // Check URLs against allowed domains
    const urlMatches = output.match(/https?:\/\/[^\s<>"]+/gi) || [];
    for (const url of urlMatches) {
      if (!this._isAllowedUrl(url)) {
        if (this.strictMode) {
          result.safe = false;
          result.blocked = {
            category: 'urlExfiltration',
            severity: 'medium',
            description: 'URL to non-allowed domain',
            match: url
          };

          this.stats.blocked++;

          await this.auditLog('output_blocked_url', {
            url,
            task: context.task
          });

          return result;
        } else {
          result.warnings.push({
            category: 'urlExfiltration',
            severity: 'low',
            description: 'URL to external domain',
            match: url
          });
        }
      }
    }

    this.stats.allowed++;
    return result;
  }

  /**
   * Check if URL is allowed
   * @private
   */
  _isAllowedUrl(url) {
    if (this.allowedDomains.length === 0) {
      return true; // No restrictions
    }

    try {
      const parsed = new URL(url);
      return this.allowedDomains.some(domain =>
        parsed.hostname === domain ||
        parsed.hostname.endsWith('.' + domain)
      );
    } catch (error) {
      // Invalid URL format - treat as disallowed for safety
      console.debug('[OutputVerifier] Invalid URL format:', url);
      return false;
    }
  }

  /**
   * Verify and sanitize output (returns sanitized or throws)
   * @param {string} output - The LLM output
   * @param {Object} [context] - Additional context
   * @returns {Promise<string>} - The verified output
   * @throws {OutputVerificationError} - If output is blocked
   */
  async verifyOrThrow(output, context = {}) {
    const result = await this.verify(output, context);

    if (!result.safe) {
      const error = new OutputVerificationError(
        `Output blocked: ${result.blocked.description}`,
        result.blocked
      );
      throw error;
    }

    return output;
  }

  /**
   * Check a specific pattern category
   * @param {string} output - The output to check
   * @param {string} category - Category name
   * @returns {Object|null} - Finding or null
   */
  checkCategory(output, category) {
    const config = this.patterns[category];
    if (!config) return null;

    for (const { regex, desc } of config.patterns) {
      const match = output.match(regex);
      if (match) {
        return {
          category,
          severity: config.severity,
          description: desc,
          match: match[0]
        };
      }
    }

    return null;
  }

  /**
   * Add a custom pattern
   * @param {RegExp} pattern
   */
  addPattern(pattern) {
    this.customPatterns.push(pattern);
  }

  /**
   * Add an allow pattern (whitelist)
   * @param {RegExp} pattern
   */
  addAllowPattern(pattern) {
    this.allowPatterns.push(pattern);
  }

  /**
   * Add allowed domain
   * @param {string} domain
   */
  addAllowedDomain(domain) {
    this.allowedDomains.push(domain);
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      blockRate: this.stats.totalChecks > 0
        ? (this.stats.blocked / this.stats.totalChecks * 100).toFixed(2) + '%'
        : 'N/A'
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalChecks: 0,
      blocked: 0,
      allowed: 0,
      byCategory: {}
    };
  }

  /**
   * Get all pattern categories
   * @returns {string[]}
   */
  getCategories() {
    return Object.keys(this.patterns);
  }

  /**
   * Get patterns for a category
   * @param {string} category
   * @returns {Object|null}
   */
  getCategoryPatterns(category) {
    return this.patterns[category] || null;
  }
}

module.exports = OutputVerifier;
module.exports.OutputVerificationError = OutputVerificationError;
