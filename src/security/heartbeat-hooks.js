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

/**
 * SecurityHeartbeatHooks - Heartbeat Cycle Security Integration
 *
 * Architecture Brief:
 * -------------------
 * Problem: Security tasks like memory integrity scans and session cleanup need
 * to run periodically, not just on every message. The HeartbeatManager already
 * provides a regular cycle (typically every 30s). This module hooks into that.
 *
 * Chosen Pattern: Observer/hook pattern. SecurityHeartbeatHooks exposes a single
 * onHeartbeat() method that the HeartbeatManager calls each cycle. Internally it
 * delegates to SecurityInterceptor.runMemoryCheck() (at a configurable interval)
 * and SecurityInterceptor.runSessionCleanup() (every heartbeat).
 *
 * Key Dependencies:
 *   - SecurityInterceptor: runMemoryCheck() -> {clean, issues, quarantined}
 *   - SecurityInterceptor: runSessionCleanup() -> {expiredSessions, expiredApprovals}
 *
 * Data Flow:
 *   HeartbeatManager.processHeartbeat()
 *     -> securityHooks.onHeartbeat()
 *       -> interceptor.runSessionCleanup()  (every beat)
 *       -> interceptor.runMemoryCheck()     (every memoryScanInterval ms)
 *     <- {memoryScan: Object|null, sessionCleanup: Object}
 *
 * @module security/heartbeat-hooks
 * @version 1.0.0
 */

'use strict';

// -----------------------------------------------------------------------------
// SecurityHeartbeatHooks Class
// -----------------------------------------------------------------------------

/**
 * Security hooks for HeartbeatManager integration.
 *
 * Usage in HeartbeatManager:
 * ```js
 * const hooks = new SecurityHeartbeatHooks(interceptor, { memoryScanInterval: 300000 });
 * // Inside processHeartbeat():
 * const secResult = await hooks.onHeartbeat();
 * ```
 */
class SecurityHeartbeatHooks {
  /**
   * Create a new SecurityHeartbeatHooks instance.
   *
   * @param {import('./interceptor')} interceptor - SecurityInterceptor instance
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.memoryScanInterval=300000] - How often to scan memory (default 5 min, in ms)
   */
  constructor(interceptor, options = {}) {
    if (!interceptor) {
      throw new Error('SecurityHeartbeatHooks requires an interceptor instance');
    }

    this.interceptor = interceptor;
    this.memoryScanInterval = options.memoryScanInterval || 5 * 60 * 1000;
    this.lastMemoryScan = 0;
  }

  /**
   * Run all security tasks for this heartbeat cycle.
   *
   * Called by HeartbeatManager on each cycle. Runs session cleanup every time
   * and memory scan at the configured interval.
   *
   * @returns {Promise<{
   *   memoryScan: {clean: boolean, issues: Array, quarantined: string[]}|null,
   *   sessionCleanup: {expiredSessions: number, expiredApprovals: number}
   * }>}
   */
  async onHeartbeat() {
    const results = {
      memoryScan: null,
      sessionCleanup: null,
    };

    // 1. Session cleanup (every heartbeat)
    results.sessionCleanup = this.interceptor.runSessionCleanup();

    // 2. Memory scan (at interval)
    const now = Date.now();
    if (now - this.lastMemoryScan >= this.memoryScanInterval) {
      try {
        results.memoryScan = await this.interceptor.runMemoryCheck();
      } catch (error) {
        console.error('Memory scan failed:', error.message);
      }
      this.lastMemoryScan = now;
    }

    return results;
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = SecurityHeartbeatHooks;
