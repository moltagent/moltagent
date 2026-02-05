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

'use strict';

/**
 * MoltAgent Security Module
 *
 * Provides security guards and wrappers for protecting agent I/O:
 *
 * Session 1 Guards:
 * - SecretsGuard: Detect and redact credentials in text
 * - ToolGuard: Classify operations by security level
 * - ResponseWrapper: Single enforcement point for all outgoing text
 *
 * Session 2 Guards:
 * - PromptGuard: 4-layer prompt injection detection
 * - PathGuard: Filesystem access control
 * - EgressGuard: Outbound network control
 *
 * Session 3 Components:
 * - SessionManager: Tracks ephemeral state per NC Talk room+user pair
 * - MemoryIntegrityChecker: Memory file scanning and sanitization
 *
 * Session 4 Integration:
 * - SecurityInterceptor: Central enforcement point with before/after hooks
 * - SecurityHeartbeatHooks: Memory scan + session cleanup on heartbeat cycle
 *
 * @module security
 * @version 4.0.0
 */

// Session 1 Guards
const SecretsGuard = require('./guards/secrets-guard');
const ToolGuard = require('./guards/tool-guard');
const ResponseWrapper = require('./response-wrapper');

// Session 2 Guards
const PromptGuard = require('./guards/prompt-guard');
const PathGuard = require('./guards/path-guard');
const EgressGuard = require('./guards/egress-guard');

// Session 3 Components
const SessionManager = require('./session-manager');
const MemoryIntegrityChecker = require('./memory-integrity');

// Session 4 Integration
const SecurityInterceptor = require('./interceptor');
const SecurityHeartbeatHooks = require('./heartbeat-hooks');

// Session 20: Content Provenance
const ContentProvenance = require('./content-provenance');

module.exports = {
  // Session 1
  SecretsGuard,
  ToolGuard,
  ResponseWrapper,

  // Session 2
  PromptGuard,
  PathGuard,
  EgressGuard,

  // Session 3
  SessionManager,
  MemoryIntegrityChecker,

  // Session 4
  SecurityInterceptor,
  SecurityHeartbeatHooks,

  // Session 20
  ContentProvenance,
};
