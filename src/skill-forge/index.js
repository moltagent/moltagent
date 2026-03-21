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
 * MoltAgent Skill Forge Module
 *
 * Safe skill generation from pre-validated YAML templates:
 *
 * - TemplateLoader: Load and validate YAML templates from Nextcloud WebDAV
 * - TemplateEngine: Assemble SKILL.md from template + user parameters
 * - SecurityScanner: Scan generated skills for security violations
 * - SkillActivator: Deploy skills from pending to active NC folder
 *
 * Phase 1 of Skill Forge (Session 8A): Template Engine Core
 *
 * @module skill-forge
 * @version 1.0.0
 */

const { TemplateLoader } = require('./template-loader');
const { TemplateEngine } = require('./template-engine');
const { SecurityScanner } = require('./security-scanner');
const { SkillActivator, ToolActivator } = require('./activator');
const { HttpToolExecutor } = require('./http-tool-executor');
const constants = require('./constants');

module.exports = {
  TemplateLoader,
  TemplateEngine,
  SecurityScanner,
  SkillActivator,
  ToolActivator,
  HttpToolExecutor,
  constants,
};
