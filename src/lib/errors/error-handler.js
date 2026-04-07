/**
 * Unified Error Handler for Moltagent
 *
 * Centralized error handling with:
 * - Error classification into safe categories
 * - Safe user messages (no internal details exposed)
 * - Full internal logging for debugging
 * - Helper functions for common patterns
 *
 * @module error-handler
 * @version 1.0.0
 */

/**
 * Error categories enum
 */
const ErrorCategory = {
  AUTHENTICATION: 'AUTHENTICATION',
  AUTHORIZATION: 'AUTHORIZATION',
  NETWORK: 'NETWORK',
  RATE_LIMITED: 'RATE_LIMITED',
  EXTERNAL_SERVICE: 'EXTERNAL_SERVICE',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFIGURATION: 'CONFIGURATION',
  TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
  OUTPUT_BLOCKED: 'OUTPUT_BLOCKED'
};

/**
 * Safe user messages for each category
 */
const SAFE_MESSAGES = {
  [ErrorCategory.AUTHENTICATION]: 'Authentication failed. Please check your credentials or try again.',
  [ErrorCategory.AUTHORIZATION]: "You don't have permission to perform this action.",
  [ErrorCategory.NETWORK]: 'Unable to reach the service. Please try again in a moment.',
  [ErrorCategory.RATE_LIMITED]: 'Too many requests. Please wait a moment and try again.',
  [ErrorCategory.EXTERNAL_SERVICE]: 'An external service is temporarily unavailable. Please try again.',
  [ErrorCategory.VALIDATION]: 'The request could not be processed. Please check your input.',
  [ErrorCategory.NOT_FOUND]: 'The requested resource was not found.',
  [ErrorCategory.CONFIGURATION]: 'This feature is not configured. Please contact your administrator.',
  [ErrorCategory.TIMEOUT]: 'The AI service took too long to respond. Please try again — it usually works on the second attempt.',
  [ErrorCategory.INTERNAL]: 'Something unexpected went wrong on my end. Please try again in a moment.',
  [ErrorCategory.OUTPUT_BLOCKED]: 'The response was blocked for safety reasons.'
};

/**
 * Log levels for each category
 */
const LOG_LEVELS = {
  [ErrorCategory.AUTHENTICATION]: 'WARN',
  [ErrorCategory.AUTHORIZATION]: 'WARN',
  [ErrorCategory.NETWORK]: 'ERROR',
  [ErrorCategory.RATE_LIMITED]: 'WARN',
  [ErrorCategory.EXTERNAL_SERVICE]: 'ERROR',
  [ErrorCategory.VALIDATION]: 'INFO',
  [ErrorCategory.NOT_FOUND]: 'INFO',
  [ErrorCategory.CONFIGURATION]: 'ERROR',
  [ErrorCategory.TIMEOUT]: 'WARN',
  [ErrorCategory.INTERNAL]: 'ERROR',
  [ErrorCategory.OUTPUT_BLOCKED]: 'WARN'
};

/**
 * Custom error class for Moltagent
 */
class MoltAgentError extends Error {
  /**
   * @param {string} message - Internal error message (for logs)
   * @param {Object} options
   * @param {string} options.category - ErrorCategory value
   * @param {string} [options.userMessage] - Override safe user message
   * @param {Error} [options.cause] - Original error
   * @param {Object} [options.metadata] - Additional context
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'MoltAgentError';
    this.category = options.category || ErrorCategory.INTERNAL;
    this.userMessage = options.userMessage || null;
    this.cause = options.cause || null;
    this.metadata = options.metadata || {};
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Error Handler class
 */
class ErrorHandler {
  /**
   * @param {Object} config
   * @param {Function} [config.auditLog] - Async audit logging function
   * @param {string} [config.serviceName] - Name for log prefixes (e.g., 'EmailHandler')
   * @param {boolean} [config.includeRequestId] - Include request ID in user messages
   * @param {Function} [config.onError] - Callback for every error (monitoring integration)
   */
  constructor(config = {}) {
    this.auditLog = config.auditLog || (async () => {});
    this.serviceName = config.serviceName || 'Moltagent';
    this.includeRequestId = config.includeRequestId || false;
    this.onError = config.onError || null;
  }

  /**
   * Handle an error and return a safe response
   * @param {Error} error - The caught error
   * @param {Object} context - Context about where the error occurred
   * @param {string} context.operation - What operation was being performed
   * @param {string} [context.user] - User who triggered the operation
   * @param {string} [context.requestId] - Request tracking ID
   * @param {Object} [context.metadata] - Additional context (non-sensitive)
   * @returns {Promise<Object>} - { message: string, category: string, logged: boolean }
   */
  async handle(error, context = {}) {
    const category = this.classify(error);
    const userMessage = this.getUserMessage(category, {
      requestId: context.requestId
    });

    // Log internally with full details
    await this.logInternal(error, category, context);

    // Call error callback if configured
    if (this.onError) {
      try {
        await this.onError(error, category, context);
      } catch (callbackError) {
        console.error('[ErrorHandler] onError callback failed:', callbackError.message);
      }
    }

    return {
      message: userMessage,
      category,
      logged: true
    };
  }

  /**
   * Classify an error into a category
   * @param {Error} error
   * @returns {string} - ErrorCategory value
   */
  classify(error) {
    if (!error) {
      return ErrorCategory.INTERNAL;
    }

    const msg = (error.message || '').toLowerCase();
    const code = error.code || '';
    const status = error.status || error.statusCode;

    // Check for custom MoltAgentError
    if (error instanceof MoltAgentError) {
      return error.category;
    }

    // Check for OutputVerificationError
    if (error.name === 'OutputVerificationError') {
      return ErrorCategory.OUTPUT_BLOCKED;
    }

    // HTTP status codes
    if (status === 401) return ErrorCategory.AUTHENTICATION;
    if (status === 403) return ErrorCategory.AUTHORIZATION;
    if (status === 404) return ErrorCategory.NOT_FOUND;
    if (status === 429) return ErrorCategory.RATE_LIMITED;
    if (status >= 500) return ErrorCategory.EXTERNAL_SERVICE;

    // Error codes
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
      return ErrorCategory.NETWORK;
    }
    if (code === 'ETIMEDOUT') {
      return ErrorCategory.TIMEOUT;
    }

    // Message patterns
    if (msg.includes('authentication') || msg.includes('auth failed') ||
        msg.includes('invalid credentials') || msg.includes('login failed')) {
      return ErrorCategory.AUTHENTICATION;
    }
    if (msg.includes('permission') || msg.includes('forbidden') || msg.includes('not authorized')) {
      return ErrorCategory.AUTHORIZATION;
    }
    if (msg.includes('not found') || msg.includes('does not exist')) {
      return ErrorCategory.NOT_FOUND;
    }
    if (msg.includes('not configured') || msg.includes('missing config') ||
        msg.includes('please add') || msg.includes('please configure')) {
      return ErrorCategory.CONFIGURATION;
    }
    if (msg.includes('rate limit') || msg.includes('too many requests')) {
      return ErrorCategory.RATE_LIMITED;
    }
    if (msg.includes('network') || msg.includes('connection') || msg.includes('socket')) {
      return ErrorCategory.NETWORK;
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return ErrorCategory.TIMEOUT;
    }
    if (msg.includes('overloaded') || msg.includes('overload')) {
      return ErrorCategory.RATE_LIMITED;
    }
    if (msg.includes('invalid') || msg.includes('required') || msg.includes('malformed')) {
      return ErrorCategory.VALIDATION;
    }

    // Default
    return ErrorCategory.INTERNAL;
  }

  /**
   * Get the safe user message for a category
   * @param {string} category - ErrorCategory value
   * @param {Object} [options] - Optional overrides
   * @param {string} [options.requestId] - Request ID to include
   * @returns {string}
   */
  getUserMessage(category, options = {}) {
    let message = SAFE_MESSAGES[category] || SAFE_MESSAGES[ErrorCategory.INTERNAL];

    // Include request ID if configured and available
    if (this.includeRequestId && options.requestId) {
      message += ` (Reference: ${options.requestId})`;
    }

    return message;
  }

  /**
   * Log error internally with full details
   * @param {Error} error
   * @param {string} category
   * @param {Object} context
   */
  async logInternal(error, category, context = {}) {
    const level = LOG_LEVELS[category] || 'ERROR';
    const timestamp = new Date().toISOString();

    // Build log entry
    const logEntry = {
      timestamp,
      level,
      service: this.serviceName,
      operation: context.operation || 'unknown',
      category,
      requestId: context.requestId || null,
      user: context.user || null,
      error: {
        name: error.name,
        message: error.message,
        code: error.code || null,
        stack: error.stack || null
      },
      metadata: context.metadata || {}
    };

    // Console output (short format)
    const consoleMsg = `[${this.serviceName}] ${level} ${context.operation}: ${category} - ${error.message}${context.requestId ? ` (reqId: ${context.requestId})` : ''}`;
    console.error(consoleMsg);

    // Full log via audit log (if available)
    try {
      await this.auditLog('error_logged', logEntry);
    } catch (auditError) {
      console.error('[ErrorHandler] Audit log failed:', auditError.message);
    }
  }
}

/**
 * Factory function to create an error handler
 * @param {Object} config - Configuration options
 * @returns {ErrorHandler}
 */
function createErrorHandler(config = {}) {
  return new ErrorHandler(config);
}

/**
 * Wrap an async function with error handling
 * @param {Function} fn - Async function to wrap
 * @param {ErrorHandler} handler - Error handler instance
 * @param {Object} defaultContext - Default context for errors
 * @returns {Function} - Wrapped function
 */
function wrapAsync(fn, handler, defaultContext = {}) {
  return async function(...args) {
    try {
      return await fn.apply(this, args);
    } catch (error) {
      const result = await handler.handle(error, defaultContext);
      // Rethrow with safe message
      throw new Error(result.message);
    }
  };
}

/**
 * Log an error and continue (replacement for empty catch)
 * @param {ErrorHandler} handler - Error handler instance
 * @param {string} operation - What was being attempted
 * @param {string} [level='warn'] - Log level
 * @returns {Function} - Catch handler function
 */
function logAndIgnore(handler, operation, level = 'warn') {
  return async function(error) {
    const category = handler.classify(error);
    await handler.logInternal(error, category, { operation });
  };
}

/**
 * Log an error and rethrow it (for error enrichment)
 * @param {ErrorHandler} handler - Error handler instance
 * @param {string} operation - What was being attempted
 * @returns {Function} - Catch handler function
 */
function logAndRethrow(handler, operation) {
  return async function(error) {
    const category = handler.classify(error);
    await handler.logInternal(error, category, { operation });
    throw error;
  };
}

module.exports = {
  ErrorHandler,
  ErrorCategory,
  MoltAgentError,
  createErrorHandler,
  wrapAsync,
  logAndIgnore,
  logAndRethrow
};
