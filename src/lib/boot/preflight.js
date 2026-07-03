/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
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

/**
 * Moltagent Boot Preflight (#87)
 *
 * Architecture Brief:
 * -------------------
 * Problem: the system asserted nothing about its own composition at startup.
 * A missing OPTIONAL dependency crashed instead of disabling (email → restart
 * loop); a missing REQUIRED dependency retried forever instead of failing
 * clearly (Collectives → silent 404 cascade). Same generator, opposite
 * branches: no startup structure knew required from optional.
 *
 * Pattern: ONE declared dependency manifest (data, single home — the parallel-
 * copies-drift archetype from #87 forbids a second list). The preflight walks
 * it at boot, probes each entry, and prints one [PREFLIGHT] line per entry:
 *
 *   [PREFLIGHT] NC Talk: OK (reachable, app enabled)
 *   [PREFLIGHT] Speaches STT/TTS: OPTIONAL, not reachable — voice features disabled this boot
 *   [PREFLIGHT][FATAL] NC Collectives: REQUIRED and not installed — install it: <url>
 *
 * Halt discipline (the do-not-brick-production rule from #87):
 *   - REQUIRED + definitively absent (a 2xx answer proving the app/endpoint
 *     is not there, or a 404 from the app's own API) → halt=true; the caller
 *     exits cleanly with the remediation line. One line, one exit, no cascade.
 *   - REQUIRED + unreachable/timeout (network hiccup, slow NC) → WARN and
 *     continue. A transient outage is not a misconfiguration; halting here
 *     would brick healthy installs on a slow morning.
 *   - OPTIONAL + absent/unreachable/not configured → one line, the feature
 *     degrades, boot continues.
 *   - MOLTAGENT_PREFLIGHT=warn demotes even definitive required-absence to a
 *     warning (deployment escape hatch; documented in .env.example).
 *
 * Key Dependencies:
 *   - NCRequestManager (injected): NC-side probes ride the authenticated
 *     request path (capabilities, app APIs).
 *   - global fetch (Node >= 18): non-NC probes (Ollama, SearXNG, Speaches).
 *
 * Data Flow:
 *   run() → probe each manifest entry (NC capabilities fetched once, shared)
 *         → { halt, results[] } → webhook-server prints the table and exits
 *           on halt (unless demoted).
 *
 * Dependency Map:
 *   BootPreflight
 *     ← webhook-server initialize() (after NCRequestManager, before subsystems)
 *     → NCRequestManager (NC probes), fetch (endpoint probes)
 *
 * @module boot/preflight
 */

'use strict';

const PROBE_TIMEOUT_MS = 5000;

/** Probe outcome statuses. */
const STATUS = {
  OK: 'ok',                          // reachable and present
  MISSING: 'missing',                // definitively absent (2xx proof or app-404)
  UNREACHABLE: 'unreachable',        // network error / timeout — presence unknown
  NOT_CONFIGURED: 'not-configured',  // no endpoint configured (optional only)
};

class BootPreflight {
  /**
   * @param {Object} options
   * @param {Object} options.config - Loaded CONFIG object
   * @param {Object} options.ncRequestManager - Authenticated NC request manager
   * @param {Object} [options.logger]
   * @param {Function} [options.fetchImpl] - Injectable fetch for tests
   */
  constructor({ config, ncRequestManager, logger, fetchImpl }) {
    this.config = config;
    this.nc = ncRequestManager;
    this.logger = logger || console;
    this.fetch = fetchImpl || globalThis.fetch;
    this._capabilities = undefined; // fetched once, shared by NC-app probes
  }

  /**
   * The dependency manifest — the single declared home for what Moltagent is
   * composed of (#87). `kind` decides the failure branch; `configHint` names
   * where to fix an absence; `remediation` is the required-absent install
   * pointer; `feature` names what degrades when an optional entry is absent.
   */
  manifest() {
    const cfg = this.config;
    const ollamaUrl = cfg.ollama && cfg.ollama.url;
    const searxngUrl = cfg.search && cfg.search.searxng && cfg.search.searxng.url;
    const speachesUrl = cfg.voice && cfg.voice.speachesUrl;
    return [
      {
        name: 'Nextcloud API', kind: 'required',
        configHint: 'NC_URL + nc-password credential',
        remediation: 'check NC_URL and the nc-password credential',
        probe: () => this._probeCapabilities(),
      },
      {
        name: 'NC Talk', kind: 'required',
        configHint: 'Talk (spreed) app on the Nextcloud host',
        remediation: 'install it: https://apps.nextcloud.com/apps/spreed',
        probe: () => this._probeCapabilityKey('spreed'),
      },
      {
        name: 'NC Deck', kind: 'required',
        configHint: 'Deck app on the Nextcloud host',
        remediation: 'install it: https://apps.nextcloud.com/apps/deck',
        probe: () => this._probeCapabilityKey('deck'),
      },
      {
        name: 'NC Collectives', kind: 'required',
        configHint: 'Collectives app on the Nextcloud host',
        remediation: 'install it: https://apps.nextcloud.com/apps/collectives',
        // Collectives registers no capability key — probe its own OCS API.
        probe: () => this._probeNcPath('/ocs/v2.php/apps/collectives/api/v1.0/collectives?format=json'),
      },
      {
        name: 'NC Mail', kind: 'optional', feature: 'email triggers and mail tools',
        configHint: 'Mail app on the Nextcloud host',
        probe: () => this._probeNcPath('/index.php/apps/mail/api/accounts'),
      },
      {
        name: 'NC News', kind: 'optional', feature: 'RSS/news tools',
        configHint: 'News app on the Nextcloud host',
        probe: () => this._probeNcPath('/index.php/apps/news/api/v1-3/feeds'),
      },
      {
        name: 'Ollama', kind: 'optional', feature: 'local LLM inference',
        configHint: 'OLLAMA_URL',
        probe: () => this._probeOllama(ollamaUrl),
      },
      {
        name: `Embedding model (${(cfg.ollama && cfg.ollama.embeddingModel) || 'unset'})`,
        kind: 'optional', feature: 'semantic memory (#96)',
        configHint: 'EMBEDDING_MODEL (pull it on the Ollama host)',
        probe: () => this._probeEmbeddingModel(ollamaUrl, cfg.ollama && cfg.ollama.embeddingModel),
      },
      {
        name: 'SearXNG', kind: 'optional', feature: 'sovereign web search',
        configHint: 'SEARXNG_URL',
        probe: () => this._probeHttp(searxngUrl),
      },
      {
        name: 'Speaches STT/TTS', kind: 'optional', feature: 'voice',
        configHint: 'SPEACHES_URL / WHISPER_URL',
        probe: () => this._probeHttp(speachesUrl),
      },
    ];
  }

  /**
   * Run every probe and log the preflight table.
   * @returns {Promise<{halt: boolean, results: Array}>} halt=true when a
   *   required dependency is DEFINITIVELY absent (never on mere unreachability).
   */
  async run() {
    const results = [];
    let halt = false;

    for (const entry of this.manifest()) {
      let status;
      let detail = '';
      try {
        const outcome = await entry.probe();
        status = outcome.status;
        detail = outcome.detail || '';
      } catch (err) {
        status = STATUS.UNREACHABLE;
        detail = err && err.message;
      }
      results.push({ name: entry.name, kind: entry.kind, status, detail, feature: entry.feature });

      if (entry.kind === 'required') {
        if (status === STATUS.OK) {
          this.logger.info(`[PREFLIGHT] ${entry.name}: OK${detail ? ` (${detail})` : ''}`);
        } else if (status === STATUS.MISSING) {
          halt = true;
          this.logger.error(`[PREFLIGHT][FATAL] ${entry.name}: REQUIRED and not installed — ${entry.remediation}`);
        } else {
          // Unreachable ≠ absent: warn, do not brick a healthy install on a hiccup.
          this.logger.warn(`[PREFLIGHT][WARN] ${entry.name}: REQUIRED but unreachable right now (${detail || 'no response'}) — continuing; check ${entry.configHint}`);
        }
      } else {
        if (status === STATUS.OK) {
          this.logger.info(`[PREFLIGHT] ${entry.name}: OK${detail ? ` (${detail})` : ''}`);
        } else if (status === STATUS.NOT_CONFIGURED) {
          this.logger.info(`[PREFLIGHT] ${entry.name}: OPTIONAL, not configured (${entry.configHint}) — ${entry.feature} disabled this boot`);
        } else {
          this.logger.warn(`[PREFLIGHT] ${entry.name}: OPTIONAL, ${status === STATUS.MISSING ? 'not installed' : 'not reachable'} — ${entry.feature} disabled this boot`);
        }
      }
    }

    return { halt, results };
  }

  /** Fetch NC capabilities once; shared by the NC-app probes. @private */
  async _getCapabilities() {
    if (this._capabilities !== undefined) return this._capabilities;
    try {
      const res = await this.nc.request('/ocs/v2.php/cloud/capabilities?format=json', {
        method: 'GET',
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
      });
      if (res && res.status >= 200 && res.status < 300) {
        const parsed = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
        this._capabilities = (parsed && parsed.ocs && parsed.ocs.data && parsed.ocs.data.capabilities) || null;
      } else {
        this._capabilities = null;
      }
    } catch (_) {
      this._capabilities = null;
    }
    return this._capabilities;
  }

  /** Nextcloud core reachable = capabilities answered. @private */
  async _probeCapabilities() {
    const caps = await this._getCapabilities();
    return caps
      ? { status: STATUS.OK, detail: 'capabilities answered' }
      : { status: STATUS.UNREACHABLE, detail: 'capabilities not answered' };
  }

  /**
   * App present = its key appears in a SUCCESSFULLY fetched capabilities
   * document. Absence is only definitive when the document itself arrived.
   * @private
   */
  async _probeCapabilityKey(key) {
    const caps = await this._getCapabilities();
    if (!caps) return { status: STATUS.UNREACHABLE, detail: 'capabilities not answered' };
    return Object.prototype.hasOwnProperty.call(caps, key)
      ? { status: STATUS.OK, detail: 'reachable, app enabled' }
      : { status: STATUS.MISSING, detail: `no '${key}' capability` };
  }

  /**
   * Probe an NC app by its own API path: 2xx = present; 404 = definitively
   * absent (the app's route does not exist); anything else = unknown.
   * @private
   */
  async _probeNcPath(path) {
    try {
      const res = await this.nc.request(path, {
        method: 'GET',
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
      });
      if (res && res.status >= 200 && res.status < 300) return { status: STATUS.OK, detail: 'reachable, app enabled' };
      if (res && res.status === 404) return { status: STATUS.MISSING, detail: '404 from app API' };
      return { status: STATUS.UNREACHABLE, detail: `HTTP ${res && res.status}` };
    } catch (err) {
      if (err && err.statusCode === 404) return { status: STATUS.MISSING, detail: '404 from app API' };
      return { status: STATUS.UNREACHABLE, detail: err && err.message };
    }
  }

  /** Plain HTTP reachability with timeout; any HTTP answer counts as up. @private */
  async _probeHttp(url) {
    if (!url) return { status: STATUS.NOT_CONFIGURED };
    try {
      const res = await this._fetchWithTimeout(url);
      return { status: STATUS.OK, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { status: STATUS.UNREACHABLE, detail: err && err.message };
    }
  }

  /** Ollama up = /api/tags answers 2xx. @private */
  async _probeOllama(ollamaUrl) {
    if (!ollamaUrl) return { status: STATUS.NOT_CONFIGURED };
    try {
      const res = await this._fetchWithTimeout(`${ollamaUrl.replace(/\/$/, '')}/api/tags`);
      return res.ok
        ? { status: STATUS.OK, detail: 'reachable' }
        : { status: STATUS.UNREACHABLE, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { status: STATUS.UNREACHABLE, detail: err && err.message };
    }
  }

  /**
   * Embedding model present = it appears in Ollama's tag list (matched on the
   * base name so 'nomic-embed-text:latest' satisfies 'nomic-embed-text').
   * @private
   */
  async _probeEmbeddingModel(ollamaUrl, model) {
    if (!ollamaUrl || !model) return { status: STATUS.NOT_CONFIGURED };
    try {
      const res = await this._fetchWithTimeout(`${ollamaUrl.replace(/\/$/, '')}/api/tags`);
      if (!res.ok) return { status: STATUS.UNREACHABLE, detail: `HTTP ${res.status}` };
      const data = await res.json();
      const models = (data && data.models) || [];
      const present = models.some((m) => m && typeof m.name === 'string' && m.name.split(':')[0] === model.split(':')[0]);
      return present
        ? { status: STATUS.OK, detail: 'pulled on Ollama host' }
        : { status: STATUS.MISSING, detail: `not in Ollama tag list — ollama pull ${model}` };
    } catch (err) {
      return { status: STATUS.UNREACHABLE, detail: err && err.message };
    }
  }

  /** @private */
  async _fetchWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      return await this.fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { BootPreflight, STATUS };
