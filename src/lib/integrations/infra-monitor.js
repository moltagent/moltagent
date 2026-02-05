/**
 * InfraMonitor — Infrastructure health probing, transition detection, self-heal.
 *
 * Owns a registry of HTTP-based health probes for the services the agent depends
 * on (Ollama, Whisper, SearXNG, Nextcloud). Each heartbeat pulse that passes
 * `shouldCheck()` triggers `checkAll()`, which:
 *   1. Runs every registered probe in parallel (with per-probe timeout).
 *   2. Detects state transitions (up→down, down→up, etc.).
 *   3. Sends human-readable Talk notifications on meaningful transitions.
 *   4. Attempts safe self-heal for Ollama (model reload).
 *   5. Collects OS-level stats (RAM, disk, uptime).
 *
 * @module integrations/infra-monitor
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');

const NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

class InfraMonitor {
  /**
   * @param {Object} config
   * @param {number} [config.checkInterval=3]     - Run every Nth pulse
   * @param {number} [config.probeTimeoutMs=8000]  - Per-probe HTTP timeout
   * @param {boolean} [config.selfHealEnabled=true]
   * @param {boolean} [config.notifyOnFailure=true]
   * @param {string}  [config.ollamaModel='qwen3:8b']
   * @param {Function} [config.notifyUser]  - async (notification) => void
   * @param {Function} [config.auditLog]    - async (event, data) => void
   * @param {Object}  [config.services]     - {ollama:{url,selfHeal?}, whisper:{url}, ...}
   */
  constructor(config = {}) {
    this.checkInterval = config.checkInterval || 3;
    this.probeTimeoutMs = config.probeTimeoutMs || 8000;
    this.selfHealEnabled = config.selfHealEnabled !== false;
    this.notifyOnFailure = config.notifyOnFailure !== false;
    this.ollamaUrl = null;
    this.ollamaModel = config.ollamaModel || 'qwen3:8b';
    this.notifyUser = config.notifyUser || null;
    this.auditLog = config.auditLog || (async () => {});

    this.probes = [];         // [{id, name, url, selfHeal?, probeFn}]
    this.state = new Map();   // id -> {status, lastCheck, consecutiveFailures}
    this._hasRunBefore = false;
    this._lastNotification = new Map(); // id -> timestamp

    this._registerDefaultProbes(config.services || {});
  }

  // ---------------------------------------------------------------------------
  // Probe registration
  // ---------------------------------------------------------------------------

  /**
   * Build probe list from services config.
   * @private
   */
  _registerDefaultProbes(services) {
    if (services.ollama && services.ollama.url) {
      this.ollamaUrl = services.ollama.url;
      this.probes.push({
        id: 'ollama',
        name: 'Ollama (Local AI)',
        url: services.ollama.url,
        selfHeal: services.ollama.selfHeal || null,
        probeFn: (url, timeout) => this._probeOllama(url, timeout)
      });
    }

    if (services.whisper && services.whisper.url) {
      this.probes.push({
        id: 'whisper',
        name: 'Whisper (Voice)',
        url: services.whisper.url,
        selfHeal: null,
        probeFn: (url, timeout) => this._probeGeneric(url, '/health', timeout)
      });
    }

    if (services.searxng && services.searxng.url) {
      this.probes.push({
        id: 'searxng',
        name: 'SearXNG (Search)',
        url: services.searxng.url,
        selfHeal: null,
        probeFn: (url, timeout) => this._probeGeneric(url, '/healthz', timeout)
      });
    }

    if (services.nextcloud && services.nextcloud.url) {
      this.probes.push({
        id: 'nextcloud',
        name: 'Nextcloud',
        url: services.nextcloud.url,
        selfHeal: null,
        probeFn: (url, timeout) => this._probeNextcloud(url, timeout)
      });
    }

    // Initialize state for each probe
    for (const probe of this.probes) {
      this.state.set(probe.id, {
        status: 'unknown',
        lastCheck: null,
        consecutiveFailures: 0
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Probe functions
  // ---------------------------------------------------------------------------

  /**
   * Probe Ollama: GET /api/tags — expects JSON with models list.
   * @private
   */
  async _probeOllama(baseUrl, timeoutMs) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      const latencyMs = Date.now() - start;
      if (!res.ok) return { ok: false, latencyMs, status: 'down', error: `HTTP ${res.status}` };
      const data = await res.json();
      const modelCount = Array.isArray(data.models) ? data.models.length : 0;
      return { ok: true, latencyMs, status: 'up', detail: `${modelCount} models loaded` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, status: 'down', error: err.name === 'AbortError' ? 'Timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Probe a generic service: GET baseUrl + path.
   * @private
   */
  async _probeGeneric(baseUrl, path, timeoutMs) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
      const latencyMs = Date.now() - start;
      if (!res.ok) return { ok: false, latencyMs, status: 'down', error: `HTTP ${res.status}` };
      return { ok: true, latencyMs, status: 'up' };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, status: 'down', error: err.name === 'AbortError' ? 'Timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Probe Nextcloud: GET /status.php — parse maintenance flag.
   * @private
   */
  async _probeNextcloud(baseUrl, timeoutMs) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/status.php`, { signal: controller.signal });
      const latencyMs = Date.now() - start;
      if (!res.ok) return { ok: false, latencyMs, status: 'down', error: `HTTP ${res.status}` };
      const data = await res.json();
      if (data.maintenance) {
        return { ok: false, latencyMs, status: 'down', detail: 'maintenance mode', error: 'Maintenance mode' };
      }
      return { ok: true, latencyMs, status: 'up', detail: `v${data.versionstring || '?'}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, status: 'down', error: err.name === 'AbortError' ? 'Timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Core: shouldCheck / checkAll
  // ---------------------------------------------------------------------------

  /**
   * Whether this pulse should trigger a health check.
   * @param {number} pulseCount
   * @returns {boolean}
   */
  shouldCheck(pulseCount) {
    return pulseCount % this.checkInterval === 0;
  }

  /**
   * Run all probes, detect transitions, attempt self-heal, collect OS stats.
   * @returns {Promise<Object>} InfraCheckResult
   */
  async checkAll() {
    const timestamp = new Date().toISOString();
    const services = {};
    const selfHealAttempts = [];

    // Run all probes in parallel
    const probeResults = await Promise.allSettled(
      this.probes.map(async (probe) => {
        const result = await probe.probeFn(probe.url, this.probeTimeoutMs);
        return { id: probe.id, result };
      })
    );

    // Collect results (Promise.allSettled preserves order matching this.probes)
    for (let i = 0; i < probeResults.length; i++) {
      const settled = probeResults[i];
      if (settled.status === 'fulfilled') {
        const { id, result } = settled.value;
        services[id] = result;
      } else {
        // Promise rejection (shouldn't happen since probes catch internally)
        const id = this.probes[i]?.id || 'unknown';
        services[id] = { ok: false, latencyMs: 0, status: 'down', error: settled.reason?.message || 'Unknown error' };
      }
    }

    // Detect transitions
    const transitions = this._detectTransitions(services);

    // Self-heal
    for (const transition of transitions) {
      if (transition.to === 'down' && this.selfHealEnabled) {
        const probe = this.probes.find(p => p.id === transition.service);
        if (probe && probe.selfHeal === 'ollama_reload') {
          const healStart = Date.now();
          try {
            await this._selfHealOllama(this.ollamaModel);
            selfHealAttempts.push({ service: transition.service, success: true, durationMs: Date.now() - healStart });
          } catch (err) {
            selfHealAttempts.push({ service: transition.service, success: false, durationMs: Date.now() - healStart, error: err.message });
          }
        }
      }
    }

    // Notify transitions
    if (this.notifyOnFailure && this.notifyUser) {
      await this._notifyTransitions(transitions);
    }

    // Update internal state
    for (const probe of this.probes) {
      const result = services[probe.id];
      if (!result) continue;
      const prev = this.state.get(probe.id);
      this.state.set(probe.id, {
        status: result.ok ? 'up' : 'down',
        lastCheck: timestamp,
        consecutiveFailures: result.ok ? 0 : (prev.consecutiveFailures + 1)
      });
    }

    this._hasRunBefore = true;

    // Collect system stats
    let systemStats = { ramUsedPct: null, diskUsedPct: null, uptimeDays: null };
    let ollamaStats = null;
    try {
      systemStats = await this.getSystemStats();
    } catch { /* ignore */ }
    try {
      ollamaStats = await this.getOllamaStats();
    } catch { /* ignore */ }

    // Compute overall status
    const allUp = this.probes.every(p => services[p.id]?.ok);
    const allDown = this.probes.length > 0 && this.probes.every(p => !services[p.id]?.ok);
    const overall = allUp ? 'ok' : (allDown ? 'down' : 'degraded');

    const result = {
      timestamp,
      services,
      transitions,
      selfHealAttempts,
      systemStats,
      ollamaStats,
      overall
    };

    await this.auditLog('infra_check', {
      overall,
      servicesChecked: Object.keys(services).length,
      transitions: transitions.length,
      selfHealAttempts: selfHealAttempts.length
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Transition detection
  // ---------------------------------------------------------------------------

  /**
   * Compare new probe results against stored state. Return transition array.
   * @private
   */
  _detectTransitions(newResults) {
    const transitions = [];

    for (const probe of this.probes) {
      const result = newResults[probe.id];
      if (!result) continue;

      const prev = this.state.get(probe.id);
      const prevStatus = prev ? prev.status : 'unknown';
      const newStatus = result.ok ? 'up' : 'down';

      if (prevStatus !== newStatus) {
        transitions.push({
          service: probe.id,
          from: prevStatus,
          to: newStatus,
          timestamp: new Date().toISOString(),
          error: result.error || null
        });
      }
    }

    return transitions;
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  /**
   * Send Talk messages for meaningful state transitions.
   * State machine:
   *   unknown → up:   No notification (startup baseline)
   *   unknown → down: NOTIFY
   *   up → down:      NOTIFY + self-heal
   *   down → up:      NOTIFY recovery
   * @private
   */
  async _notifyTransitions(transitions) {
    for (const t of transitions) {
      // Skip unknown → up (first-run baseline)
      if (t.from === 'unknown' && t.to === 'up') continue;

      // Check notification cooldown (1-hour per service, skip for recovery — always notify recovery)
      if (t.to !== 'up') {
        const lastNotify = this._lastNotification.get(t.service);
        if (lastNotify && Date.now() - lastNotify < NOTIFICATION_COOLDOWN_MS) continue;
      }

      let message;
      if (t.to === 'down') {
        message = this._getDownMessage(t.service);
      } else if (t.to === 'up') {
        const probe = this.probes.find(p => p.id === t.service);
        message = this._getRecoveryMessage(t.service, probe?.name);
      }

      if (message && this.notifyUser) {
        try {
          await this.notifyUser({ type: 'infra', message });
          this._lastNotification.set(t.service, Date.now());
        } catch (err) {
          console.error(`[InfraMonitor] Failed to notify for ${t.service}:`, err.message);
        }
      }
    }
  }

  /**
   * Human-readable down message per service.
   * @private
   */
  _getDownMessage(probeId) {
    const messages = {
      ollama: "⚠️ Local AI service is not responding\n\nI'll use cloud AI as a fallback, so I'm still working — but local-only operations won't process until this is resolved.\n\nIf you have terminal access:\n`ssh ollama-vm` then `systemctl restart ollama`",
      whisper: "⚠️ Voice input is temporarily unavailable\n\nPlease type your messages instead. Everything else works normally.\n\nIf you have terminal access:\n`ssh ollama-vm` then `systemctl restart whisper-server`",
      searxng: "⚠️ Web search is temporarily unavailable\n\nI can't search the web right now. I'll still work with my existing knowledge.\n\nIf you have terminal access:\n`systemctl restart searxng`",
      nextcloud: "🔴 I'm having trouble reaching Nextcloud\n\nIf this persists, I won't be able to read tasks, check calendar, or access files. I'll keep trying.\n\nIf Nextcloud is in maintenance mode, this is expected."
    };
    return messages[probeId] || `⚠️ ${probeId} is not responding`;
  }

  /**
   * Human-readable recovery message.
   * @private
   */
  _getRecoveryMessage(probeId, name) {
    return `✅ ${name || probeId} is back online. Everything is working normally.`;
  }

  // ---------------------------------------------------------------------------
  // Self-heal
  // ---------------------------------------------------------------------------

  /**
   * Attempt to reload an Ollama model by sending a minimal generate request.
   * Fire-and-forget (120s timeout, doesn't block pulse).
   * @param {string} model
   */
  async _selfHealOllama(model) {
    if (!this.ollamaUrl) throw new Error('No Ollama URL configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'ping', stream: false, options: { num_predict: 1 } }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // OS Stats
  // ---------------------------------------------------------------------------

  /**
   * Read system stats from /proc and df.
   * @returns {Promise<{ramUsedPct: number|null, diskUsedPct: number|null, uptimeDays: number|null}>}
   */
  async getSystemStats() {
    const stats = { ramUsedPct: null, diskUsedPct: null, uptimeDays: null };

    // RAM from /proc/meminfo
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const totalMatch = meminfo.match(/MemTotal:\s+(\d+)/);
      const availMatch = meminfo.match(/MemAvailable:\s+(\d+)/);
      if (totalMatch && availMatch) {
        const total = parseInt(totalMatch[1]);
        const available = parseInt(availMatch[1]);
        stats.ramUsedPct = Math.round(((total - available) / total) * 100);
      }
    } catch { /* not on Linux */ }

    // Uptime from /proc/uptime
    try {
      const uptimeStr = fs.readFileSync('/proc/uptime', 'utf8');
      const seconds = parseFloat(uptimeStr.split(' ')[0]);
      stats.uptimeDays = Math.floor(seconds / 86400);
    } catch { /* not on Linux */ }

    // Disk from df
    try {
      const output = await new Promise((resolve, reject) => {
        execFile('df', ['--output=pcent', '/'], { timeout: 5000 }, (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout);
        });
      });
      const match = output.match(/(\d+)%/);
      if (match) stats.diskUsedPct = parseInt(match[1]);
    } catch { /* df not available */ }

    return stats;
  }

  /**
   * Get Ollama running model info from /api/ps.
   * @returns {Promise<{models: Array}|null>}
   */
  async getOllamaStats() {
    if (!this.ollamaUrl) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs);
    try {
      const res = await fetch(`${this.ollamaUrl}/api/ps`, { signal: controller.signal });
      if (!res.ok) return null;
      const data = await res.json();
      return { models: data.models || [] };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  /**
   * Build current summary from internal state.
   * @returns {{services: Object, systemStats: Object|null, overall: string}}
   */
  getSummary() {
    const services = {};
    let upCount = 0;
    let downCount = 0;

    for (const probe of this.probes) {
      const s = this.state.get(probe.id);
      services[probe.id] = {
        name: probe.name,
        status: s ? s.status : 'unknown',
        lastCheck: s ? s.lastCheck : null,
        consecutiveFailures: s ? s.consecutiveFailures : 0
      };
      if (s?.status === 'up') upCount++;
      if (s?.status === 'down') downCount++;
    }

    const total = this.probes.length;
    let overall = 'unknown';
    if (total > 0) {
      if (upCount === total) overall = 'ok';
      else if (downCount === total) overall = 'down';
      else if (this._hasRunBefore) overall = 'degraded';
    }

    return { services, systemStats: null, overall };
  }
}

module.exports = InfraMonitor;
