/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * Moltagent Capabilities Module
 *
 * Provides agent self-documentation and introspection:
 *
 * - CapabilityRegistry: Central registry of capabilities, commands, providers
 * - HelpGenerator: Generate help text from registry
 * - StatusReporter: Generate status reports (health, providers, uptime)
 * - CapabilitiesCommandHandler: Handle /help, /status, /capabilities, /health
 *
 * @module capabilities
 */

const { CapabilityRegistry } = require('./capability-registry');
const { HelpGenerator } = require('./help-generator');
const { StatusReporter } = require('./status-reporter');
const { CapabilitiesCommandHandler } = require('./command-handler');

module.exports = {
  CapabilityRegistry,
  HelpGenerator,
  StatusReporter,
  CapabilitiesCommandHandler
};
