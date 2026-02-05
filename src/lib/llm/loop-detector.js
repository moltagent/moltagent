/**
 * Loop Detector
 *
 * Detects and prevents infinite loops in AI agent operations.
 *
 * Detects:
 * - Same call repeated multiple times
 * - Ping-pong patterns (A→B→A→B)
 * - Error loops (same error repeated)
 *
 * @module llm/loop-detector
 * @version 1.0.0
 */

const appConfig = require('../config');

class LoopDetector {
  /**
   * @param {Object} config
   * @param {number} [config.maxConsecutiveErrors] - Max same errors before blocking
   * @param {number} [config.maxSameCall] - Max identical calls before blocking
   * @param {number} [config.historyWindowMs] - Time window for history (ms)
   * @param {number} [config.pingPongThreshold] - Min calls to detect ping-pong
   * @param {Function} [config.onLoopDetected] - Callback when loop detected
   */
  constructor(config = {}) {
    this.maxConsecutiveErrors = config.maxConsecutiveErrors || appConfig.llm.loopDetectorMaxErrors;
    this.maxSameCall = config.maxSameCall || appConfig.llm.loopDetectorMaxSame;
    this.historyWindowMs = config.historyWindowMs || appConfig.llm.loopDetectorWindow;
    this.pingPongThreshold = config.pingPongThreshold || appConfig.llm.loopDetectorPingPongThreshold;
    this.onLoopDetected = config.onLoopDetected || (() => {});

    // Call history
    this.callHistory = [];

    // Error patterns
    this.errorPatterns = new Map();
  }

  /**
   * Record a call
   * @param {Object} call
   * @param {string} call.type - Call type (e.g., 'llm', 'tool', 'api')
   * @param {string} call.action - Action name
   * @param {Object} [call.params] - Call parameters
   */
  recordCall(call) {
    const entry = {
      ...call,
      signature: this._getSignature(call),
      timestamp: Date.now()
    };

    this.callHistory.push(entry);
    this._pruneHistory();
  }

  /**
   * Record an error
   * @param {Object} call - The call that failed
   * @param {Error} error - The error
   * @returns {Object} - { loopDetected, count, recommendation }
   */
  recordError(call, error) {
    const signature = this._getSignature(call);
    const entry = this.errorPatterns.get(signature) || { count: 0, errors: [] };

    entry.count++;
    entry.lastError = error.message;
    entry.lastTimestamp = Date.now();
    entry.errors.push({
      message: error.message,
      timestamp: Date.now()
    });

    // Keep only recent errors
    entry.errors = entry.errors.slice(-10);

    this.errorPatterns.set(signature, entry);

    // Check for loop
    if (entry.count >= this.maxConsecutiveErrors) {
      const result = {
        loopDetected: true,
        type: 'error_loop',
        signature,
        count: entry.count,
        lastError: error.message,
        recommendation: 'abort_and_report'
      };

      this.onLoopDetected(result);
      return result;
    }

    return { loopDetected: false };
  }

  /**
   * Check if a proposed call would create a loop
   * @param {Object} call - Proposed call
   * @returns {Object} - { blocked, reason?, suggestion? }
   */
  checkForLoop(call) {
    const signature = this._getSignature(call);

    // Check 1: Same call error pattern
    const errorEntry = this.errorPatterns.get(signature);
    if (errorEntry && errorEntry.count >= this.maxConsecutiveErrors) {
      const result = {
        blocked: true,
        type: 'error_loop',
        reason: `Call blocked: same call failed ${errorEntry.count} times`,
        suggestion: 'Try a different approach or ask for human assistance',
        count: errorEntry.count
      };
      this.onLoopDetected(result);
      return result;
    }

    // Check 2: Same call repeated too many times
    const recentSameCalls = this.callHistory.filter(c => c.signature === signature);
    if (recentSameCalls.length >= this.maxSameCall) {
      const result = {
        blocked: true,
        type: 'repetition_loop',
        reason: `Call blocked: same call made ${recentSameCalls.length} times in ${this.historyWindowMs / 1000}s`,
        suggestion: 'The operation appears stuck. Consider a different approach.',
        count: recentSameCalls.length
      };
      this.onLoopDetected(result);
      return result;
    }

    // Check 3: Ping-pong pattern
    const pingPongResult = this._checkPingPong();
    if (pingPongResult.detected) {
      const result = {
        blocked: true,
        type: 'pingpong_loop',
        reason: 'Ping-pong loop detected: oscillating between approaches',
        suggestion: 'Agent is alternating between two actions without progress. Human review needed.',
        pattern: pingPongResult.pattern
      };
      this.onLoopDetected(result);
      return result;
    }

    return { blocked: false };
  }

  /**
   * Check for ping-pong pattern (A→B→A→B)
   * @private
   */
  _checkPingPong() {
    if (this.callHistory.length < this.pingPongThreshold) {
      return { detected: false };
    }

    const recent = this.callHistory.slice(-this.pingPongThreshold);
    const signatures = recent.map(c => c.signature);

    // Check for A-B-A-B pattern
    if (signatures.length >= 4) {
      const last4 = signatures.slice(-4);
      if (
        last4[0] === last4[2] &&
        last4[1] === last4[3] &&
        last4[0] !== last4[1]
      ) {
        return {
          detected: true,
          pattern: [last4[0], last4[1]]
        };
      }
    }

    // Check for A-B-C-A-B-C pattern (longer cycle)
    if (signatures.length >= 6) {
      const last6 = signatures.slice(-6);
      if (
        last6[0] === last6[3] &&
        last6[1] === last6[4] &&
        last6[2] === last6[5]
      ) {
        return {
          detected: true,
          pattern: [last6[0], last6[1], last6[2]]
        };
      }
    }

    return { detected: false };
  }

  /**
   * Generate a signature for a call
   * @private
   */
  _getSignature(call) {
    const normalized = {
      type: call.type || 'unknown',
      action: call.action || 'unknown',
      params: this._normalizeParams(call.params)
    };
    return JSON.stringify(normalized);
  }

  /**
   * Normalize parameters for comparison
   * @private
   */
  _normalizeParams(params) {
    if (!params) return null;

    // Sort object keys for consistent comparison
    if (typeof params === 'object' && !Array.isArray(params)) {
      const sorted = {};
      for (const key of Object.keys(params).sort()) {
        sorted[key] = this._normalizeParams(params[key]);
      }
      return sorted;
    }

    if (Array.isArray(params)) {
      return params.map(p => this._normalizeParams(p));
    }

    return params;
  }

  /**
   * Prune old history entries
   * @private
   */
  _pruneHistory() {
    const cutoff = Date.now() - this.historyWindowMs;
    this.callHistory = this.callHistory.filter(c => c.timestamp > cutoff);

    // Also prune old error patterns
    for (const [signature, entry] of this.errorPatterns) {
      if (entry.lastTimestamp && entry.lastTimestamp < cutoff) {
        this.errorPatterns.delete(signature);
      }
    }
  }

  /**
   * Reset error count for a specific call pattern
   * @param {Object} call
   */
  resetErrorCount(call) {
    const signature = this._getSignature(call);
    this.errorPatterns.delete(signature);
  }

  /**
   * Clear all history and error patterns
   */
  reset() {
    this.callHistory = [];
    this.errorPatterns.clear();
  }

  /**
   * Get current state summary
   * @returns {Object}
   */
  getSummary() {
    const errorPatterns = {};
    for (const [signature, entry] of this.errorPatterns) {
      errorPatterns[signature] = {
        count: entry.count,
        lastError: entry.lastError
      };
    }

    return {
      historyLength: this.callHistory.length,
      errorPatterns,
      recentCalls: this.callHistory.slice(-10).map(c => ({
        type: c.type,
        action: c.action,
        timestamp: c.timestamp
      }))
    };
  }

  /**
   * Get count of calls by signature in current window
   * @returns {Object}
   */
  getCallCounts() {
    const counts = {};
    for (const call of this.callHistory) {
      const key = `${call.type}:${call.action}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }
}

module.exports = LoopDetector;
