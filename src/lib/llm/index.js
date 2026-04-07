/**
 * Moltagent LLM Module
 *
 * Provides role-based LLM routing with failover support.
 *
 * @module llm
 * @version 2.0.0
 */

const LLMRouter = require('./router');
const RateLimitTracker = require('./rate-limit-tracker');
const BudgetEnforcer = require('./budget-enforcer');
const BackoffStrategy = require('./backoff-strategy');
const CircuitBreaker = require('./circuit-breaker');
const LoopDetector = require('./loop-detector');
const OutputVerifier = require('../output-verifier');
const providers = require('./providers');
const configLoader = require('./config-loader');

module.exports = {
  LLMRouter,
  RateLimitTracker,
  BudgetEnforcer,
  BackoffStrategy,
  CircuitBreaker,
  LoopDetector,
  OutputVerifier,
  providers,
  configLoader,
  createProvider: providers.createProvider,
  getAvailableAdapters: providers.getAvailableAdapters,
  loadConfig: configLoader.loadConfig,
  validateConfig: configLoader.validateConfig,
  // Re-export errors and constants
  CircuitOpenError: CircuitBreaker.CircuitOpenError,
  CIRCUIT_STATES: CircuitBreaker.STATES,
  OutputVerificationError: OutputVerifier.OutputVerificationError,
  JOBS: LLMRouter.JOBS,
};
