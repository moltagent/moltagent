/**
 * Circuit Breaker
 *
 * Prevents cascading failures by temporarily disabling failing operations.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, requests are rejected
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 *
 * @module llm/circuit-breaker
 * @version 1.0.0
 */

const appConfig = require('../config');

/**
 * Custom error for circuit breaker rejections
 */
class CircuitOpenError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
    this.providerId = details.providerId;
    this.state = details.state;
    this.retryAt = details.retryAt;
  }
}

const STATES = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open'
};

class CircuitBreaker {
  /**
   * @param {Object} config
   * @param {number} [config.failureThreshold] - Failures to open circuit
   * @param {number} [config.resetTimeoutMs] - Time before trying again (ms)
   * @param {number} [config.successThreshold] - Successes to close from half-open
   * @param {Function} [config.onStateChange] - Callback on state changes
   * @param {Function} [config.onReject] - Callback when request rejected
   */
  constructor(config = {}) {
    this.failureThreshold = config.failureThreshold || appConfig.llm.circuitBreakerThreshold;
    this.resetTimeoutMs = config.resetTimeoutMs || appConfig.llm.circuitBreakerResetMs;
    this.successThreshold = config.successThreshold || appConfig.llm.circuitBreakerSuccessThreshold;
    this.onStateChange = config.onStateChange || (() => {});
    this.onReject = config.onReject || (() => {});

    // State per provider
    this.circuits = new Map();
  }

  /**
   * Get or create circuit state for a provider
   * @private
   */
  _getCircuit(providerId) {
    if (!this.circuits.has(providerId)) {
      this.circuits.set(providerId, {
        state: STATES.CLOSED,
        failures: 0,
        successes: 0,
        lastFailure: null,
        lastStateChange: Date.now()
      });
    }
    return this.circuits.get(providerId);
  }

  /**
   * Check if request is allowed for provider
   * @param {string} providerId
   * @returns {Object} - { allowed, state, reason?, retryAt? }
   */
  canRequest(providerId) {
    const circuit = this._getCircuit(providerId);
    const now = Date.now();

    switch (circuit.state) {
      case STATES.CLOSED:
        return { allowed: true, state: circuit.state };

      case STATES.OPEN:
        // Check if reset timeout has passed
        if (now - circuit.lastFailure >= this.resetTimeoutMs) {
          this._transitionTo(providerId, STATES.HALF_OPEN);
          return { allowed: true, state: STATES.HALF_OPEN };
        }
        return {
          allowed: false,
          state: circuit.state,
          reason: 'circuit_open',
          retryAt: circuit.lastFailure + this.resetTimeoutMs
        };

      case STATES.HALF_OPEN:
        // Allow limited requests to test recovery
        return { allowed: true, state: circuit.state };

      default:
        return { allowed: true, state: STATES.CLOSED };
    }
  }

  /**
   * Record a successful operation
   * @param {string} providerId
   */
  recordSuccess(providerId) {
    const circuit = this._getCircuit(providerId);

    if (circuit.state === STATES.HALF_OPEN) {
      circuit.successes++;

      if (circuit.successes >= this.successThreshold) {
        this._transitionTo(providerId, STATES.CLOSED);
      }
    } else if (circuit.state === STATES.CLOSED) {
      // Reset failure count on success
      circuit.failures = 0;
    }
  }

  /**
   * Record a failed operation
   * @param {string} providerId
   * @param {Error} [error]
   */
  recordFailure(providerId, error) {
    const circuit = this._getCircuit(providerId);
    const now = Date.now();

    circuit.failures++;
    circuit.lastFailure = now;
    circuit.lastError = error?.message || 'Unknown error';

    if (circuit.state === STATES.HALF_OPEN) {
      // Any failure in half-open goes back to open
      this._transitionTo(providerId, STATES.OPEN);
    } else if (circuit.state === STATES.CLOSED) {
      if (circuit.failures >= this.failureThreshold) {
        this._transitionTo(providerId, STATES.OPEN);
      }
    }
  }

  /**
   * Transition to a new state
   * @private
   */
  _transitionTo(providerId, newState) {
    const circuit = this._getCircuit(providerId);
    const oldState = circuit.state;

    if (oldState === newState) return;

    circuit.state = newState;
    circuit.lastStateChange = Date.now();

    // Reset counters on state change
    if (newState === STATES.CLOSED) {
      circuit.failures = 0;
      circuit.successes = 0;
    } else if (newState === STATES.HALF_OPEN) {
      circuit.successes = 0;
    }

    // Notify
    this.onStateChange({
      providerId,
      oldState,
      newState,
      failures: circuit.failures,
      lastError: circuit.lastError
    });
  }

  /**
   * Execute an operation with circuit breaker protection
   * @param {string} providerId
   * @param {Function} operation - Async function to execute
   * @returns {Promise<any>}
   */
  async execute(providerId, operation) {
    const check = this.canRequest(providerId);

    if (!check.allowed) {
      const error = new CircuitOpenError(
        `Circuit breaker is open for ${providerId}`,
        {
          providerId,
          state: check.state,
          retryAt: check.retryAt
        }
      );
      this.onReject({ providerId, error });
      throw error;
    }

    try {
      const result = await operation();
      this.recordSuccess(providerId);
      return result;
    } catch (error) {
      this.recordFailure(providerId, error);
      throw error;
    }
  }

  /**
   * Force reset a circuit to closed state
   * @param {string} providerId
   */
  reset(providerId) {
    const circuit = this._getCircuit(providerId);
    circuit.state = STATES.CLOSED;
    circuit.failures = 0;
    circuit.successes = 0;
    circuit.lastFailure = null;
    circuit.lastError = null;
    circuit.lastStateChange = Date.now();
  }

  /**
   * Force open a circuit (manual intervention)
   * @param {string} providerId
   */
  forceOpen(providerId) {
    this._transitionTo(providerId, STATES.OPEN);
    const circuit = this._getCircuit(providerId);
    circuit.lastFailure = Date.now();
  }

  /**
   * Get state for a provider
   * @param {string} providerId
   * @returns {Object}
   */
  getState(providerId) {
    const circuit = this._getCircuit(providerId);
    return {
      state: circuit.state,
      failures: circuit.failures,
      successes: circuit.successes,
      lastFailure: circuit.lastFailure,
      lastError: circuit.lastError,
      lastStateChange: circuit.lastStateChange
    };
  }

  /**
   * Get summary of all circuits
   * @returns {Object}
   */
  getSummary() {
    const summary = {};
    for (const [providerId, circuit] of this.circuits) {
      summary[providerId] = {
        state: circuit.state,
        failures: circuit.failures,
        canRequest: this.canRequest(providerId).allowed
      };
    }
    return summary;
  }

  /**
   * Get list of open circuits
   * @returns {string[]}
   */
  getOpenCircuits() {
    const open = [];
    for (const [providerId, circuit] of this.circuits) {
      if (circuit.state === STATES.OPEN) {
        open.push(providerId);
      }
    }
    return open;
  }
}

module.exports = CircuitBreaker;
module.exports.CircuitOpenError = CircuitOpenError;
module.exports.STATES = STATES;
