# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- LLM-driven GATE workflow processing with label tools and parent card resolution
- SCHEDULED and ERROR label support with priority chain (PAUSED > SCHEDULED > ERROR > GATE)
- Biological intelligence: prediction-error extraction, competitive filtering, mode inference
- Entity resolution with LLM-assisted wiki duplicate scanning and merging
- Active artifact focus: ground conversations to the artifact being discussed
- NC News integration with RSS feed scanning tools
- OAuth 2.0 broker for Skill Forge (authorization code with PKCE, client credentials, token refresh)
- Skill Forge v2: native ToolRegistry integration, auto-discover templates on startup
- Provider-agnostic LLM wiring: any YAML-configured provider works by adding a key
- Web search available in all domain tool subsets
- @mention adapter routing through full message processing pipeline
- SearXNG sovereign search integration (DuckDuckGo, Brave, Stract, Mojeek federation)
- Document ingestion with OCR, classification, and wiki routing
- Compound intent detection and decomposition
- Three-channel knowledge fusion (keyword, vector, graph) with competitive suppression
- Daily briefing and digest with job-based LLM routing
- Co-access graph with decay-weighted tracking
- Proactive knowledge gap evaluation
- Self-recovery: automatic recovery card on agent loop exhaustion
- Deck board registry with ID-based resolution
- GATE assignment handoff with persisted notifications
- Workflow card processing includes comment history in LLM context
- Cost tracking with automatic fallback to local models on budget exhaustion

### Changed
- Haiku-first routing in all cloud-ok presets (eliminates 60s Ollama timeout for tools chain)
- RESEARCH job uses Haiku instead of Sonnet (~10x cheaper, sufficient quality)
- QUICK chain: Haiku first in smart-mix, local first in all-local
- Knowledge probes routed through MemorySearcher (single path, three capabilities)
- Collapse The Doubles: net -3,903 lines removed through architectural consolidation
- All Deck board/stack names extracted into centralized config
- Trust boundary fix: MicroPipeline respects cloud-ok mode
- Budget enforcement wired into WorkflowEngine
- Ingestion cost optimization: skip unchanged files, embedding pre-filter for entity dedup

### Fixed
- PAUSED CONFIG cards no longer block schedule execution
- Workflow engine duplicate comments resolved via persisted processed-card state
- Per-card context no longer leaks schedule instructions
- GATE triple-bug (reentrancy, duplicate labels, duplicate comments)
- Shared boards invisible due to missing deck_list_boards in tool subset
- Calendar query routing with cost-optimization regression tests
- Cloud chat provider registration reads from YAML config, not legacy JSON
- WebDAV path discovery from API instead of hardcoding
- Board registry duplicate creation on restart
- Search metadata stripped from results at source

### Security
- Upstream ingestion quality gates (confidence threshold, minimum substance, fidelity)
- Entity name uncertainty flags moved from titles to frontmatter fields
- Thinking gate: skip enricher for reflection tasks (SOUL.md + living context sufficient)
