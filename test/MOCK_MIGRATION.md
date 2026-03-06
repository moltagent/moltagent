# Mock Migration Tracker

## Why This Exists

On 2026-03-05, three production failures were caused by stateless test mocks
that didn't enforce real Nextcloud API constraints. All tests passed. All
deployments failed. The mocks said yes to everything. Production said no.

Realistic mocks enforce:
- Collectives: page must exist (createPage) before content write (writePageContent)
- NCFiles: parent directory must exist before file write
- Both: read/write to nonexistent resources throws appropriate HTTP errors

## Mock Types

- **REALISTIC** — Uses RealisticCollectivesMock / RealisticNCFilesMock.
  Enforces API constraints. Catches write-before-create bugs at test time.
- **LEGACY** — Uses stateless jest.fn() mocks. Does not enforce constraints.
  May hide bugs that only surface in production.

## Migration Rules

1. **New test files** → Always use REALISTIC mocks
2. **Touching an existing file** → Migrate to REALISTIC in the same PR
3. **No dedicated migration sprint** — opportunistic, steady, never-ending
4. **Mark each file** with a comment at the top:
   ```
   // Mock type: REALISTIC (enforces Collectives/NCFiles API constraints)
   // or
   // Mock type: LEGACY — TODO: migrate to realistic mocks
   ```

## File Status

Update this list as files are migrated.

### REALISTIC (migrated)
- (none yet — list here as files are migrated)

### LEGACY (need migration)
- test/unit/agent/agent-loop-salvage.test.js
- test/unit/agent/agent-loop.test.js
- test/unit/agent/contacts-tools.test.js
- test/unit/agent/deferral-queue.test.js
- test/unit/agent/file-executor.test.js
- test/unit/agent/tool-registry.test.js
- test/unit/agent/tool-response-validation.test.js
- test/unit/agent/wiki-executor.test.js
- test/unit/agent/wiki-tools.test.js
- test/unit/integrations/calendar-alert-scoping.test.js
- test/unit/integrations/collectives-bootstrap.test.js
- test/unit/integrations/collectives-client.test.js
- test/unit/integrations/contacts-client.test.js
- test/unit/integrations/freshness-biological.test.js
- test/unit/integrations/heartbeat-intelligence.test.js
- test/unit/integrations/heartbeat-knowledge-stats.test.js
- test/unit/integrations/memory-searcher-access.test.js
- test/unit/integrations/memory-searcher-fusion.test.js
- test/unit/integrations/memory-searcher.test.js
- test/unit/integrations/nc-files-client.test.js
- test/unit/integrations/session-persister-v3.test.js
- test/unit/integrations/warm-memory.test.js
- test/unit/knowledge/context-loader.test.js
- test/unit/knowledge/freshness-checker.test.js
- test/unit/llm/cost-tracker.test.js
- test/unit/llm/job-classification.test.js
- test/unit/memory/co-access-graph.test.js
- test/unit/memory/embedding-refresher.test.js
- test/unit/memory/gap-detector.test.js
- test/unit/memory/knowledge-graph.test.js
- test/unit/memory/metadata-gardener.test.js
- test/unit/memory/rhythm-tracker.test.js
- test/unit/nc-request-manager.test.js
- test/unit/providers/audio-converter.test.js
- test/unit/security/interceptor.test.js
- test/unit/security/memory-integrity.test.js
- test/unit/server/message-processor.test.js
- test/unit/voice/voice-manager.test.js
- test/unit/voice/voice-reply.test.js
- test/integration/credential-broker.test.js
- test/red-team/adversarial-probes.test.js

### NOT APPLICABLE (no Collectives/NCFiles interaction)
- test/benchmarks/guard-performance.test.js
- test/integration/credential-integration.test.js
- test/integration/skill-forge.integration.test.js
- test/integration/webhook-server.test.js
- test/unit/agent/base-executor.test.js
- test/unit/agent/calendar-executor.test.js
- test/unit/agent/clarification-manager.test.js
- test/unit/agent/context-extraction.test.js
- test/unit/agent/deck-executor-v2.test.js
- test/unit/agent/deck-executor.test.js
- test/unit/agent/dual-model-classifier.test.js
- test/unit/agent/executors/attendee-extractor.test.js
- test/unit/agent/executors/calendar-delete-handler.test.js
- test/unit/agent/executors/calendar-query-classification.test.js
- test/unit/agent/executors/calendar-query-formatting.test.js
- test/unit/agent/executors/calendar-query-handler.test.js
- test/unit/agent/executors/calendar-update-handler.test.js
- test/unit/agent/executors/calendar-validation.test.js
- test/unit/agent/guardrail-enforcer.test.js
- test/unit/agent/intent-router.test.js
- test/unit/agent/job-classification.test.js
- test/unit/agent/memory-context-enricher.test.js
- test/unit/agent/micro-pipeline-context.test.js
- test/unit/agent/micro-pipeline-guardrails.test.js
- test/unit/agent/micro-pipeline.test.js
- test/unit/agent/orphan-tools.test.js
- test/unit/agent/proactive-evaluator.test.js
- test/unit/agent/providers/claude-tools.test.js
- test/unit/agent/providers/ollama-tools.test.js
- test/unit/agent/providers/openai-tools.test.js
- test/unit/agent/providers/provider-chain.test.js
- test/unit/agent/providers/router-chat-bridge.test.js
- test/unit/agent/reference-resolver.test.js
- test/unit/agent/regex-prerouter.test.js
- test/unit/agent/wiki-executor-introspect.test.js
- test/unit/agent/wiki-executor-remember.test.js
- test/unit/capabilities/capability-registry.test.js
- test/unit/capabilities/command-handler.test.js
- test/unit/capabilities/help-generator.test.js
- test/unit/capabilities/status-reporter.test.js
- test/unit/clients/self-heal-client.test.js
- test/unit/config.test.js
- test/unit/credential-cache.test.js
- test/unit/errors/error-handler.test.js
- test/unit/extraction/text-extractor.test.js
- test/unit/guards/egress-guard.test.js
- test/unit/guards/path-guard.test.js
- test/unit/guards/prompt-guard-ml.test.js
- test/unit/guards/prompt-guard.test.js
- test/unit/guards/secrets-guard.test.js
- test/unit/guards/tool-guard.test.js
- test/unit/handlers/calendar-handler.test.js
- test/unit/handlers/confirmation/email-reply-handler.test.js
- test/unit/handlers/confirmation/meeting-response-handler.test.js
- test/unit/handlers/confirmation/pending-action-handler.test.js
- test/unit/handlers/email-handler.test.js
- test/unit/handlers/message-router-deck.test.js
- test/unit/handlers/message-router.test.js
- test/unit/handlers/skill-forge-handler.test.js
- test/unit/integrations/bot-enroller.test.js
- test/unit/integrations/caldav-client.test.js
- test/unit/integrations/cockpit-manager.test.js
- test/unit/integrations/cockpit-models-card.test.js
- test/unit/integrations/cockpit-models.test.js
- test/unit/integrations/cockpit-modes.test.js
- test/unit/integrations/deck-board-model.test.js
- test/unit/integrations/deck-client-v2.test.js
- test/unit/integrations/deck-client.test.js
- test/unit/integrations/deck-self-assign.test.js
- test/unit/integrations/heartbeat-cockpit.test.js
- test/unit/integrations/heartbeat-daily-digest.test.js
- test/unit/integrations/heartbeat-email.test.js
- test/unit/integrations/heartbeat-initiative.test.js
- test/unit/integrations/heartbeat-intelligence-wiring.test.js
- test/unit/integrations/infra-monitor.test.js
- test/unit/integrations/multi-source-search.test.js
- test/unit/integrations/nc-search-client.test.js
- test/unit/integrations/rsvp-tracker.test.js
- test/unit/integrations/search-provider-adapters.test.js
- test/unit/integrations/searxng-client.test.js
- test/unit/integrations/session-persister-v2.test.js
- test/unit/integrations/session-persister.test.js
- test/unit/integrations/talk-multi-room.test.js
- test/unit/integrations/web-reader.test.js
- test/unit/knowledge/frontmatter.test.js
- test/unit/knowledge/knowledge-board.test.js
- test/unit/knowledge/learning-log.test.js
- test/unit/knowledge/page-templates.test.js
- test/unit/knowledge/wikilinks.test.js
- test/unit/llm/budget-enforcer.test.js
- test/unit/llm/fallback-notifier.test.js
- test/unit/llm/providers/ollama-provider.test.js
- test/unit/llm/router-jobs.test.js
- test/unit/llm/router.test.js
- test/unit/memory/activity-logger.test.js
- test/unit/memory/daily-digest.test.js
- test/unit/memory/embedding-client.test.js
- test/unit/memory/heartbeat-extractor-init.test.js
- test/unit/memory/heartbeat-extractor.test.js
- test/unit/memory/vector-store.test.js
- test/unit/nc-flow/activity-poller.test.js
- test/unit/nc-flow/heartbeat-integration.test.js
- test/unit/nc-flow/system-tags.test.js
- test/unit/nc-flow/webhook-receiver.test.js
- test/unit/nc-status-indicator.test.js
- test/unit/output-verifier.test.js
- test/unit/pending-action-store.test.js
- test/unit/providers/known-providers.test.js
- test/unit/providers/model-scout.test.js
- test/unit/providers/ollama-credential-model.test.js
- test/unit/providers/whisper-client.test.js
- test/unit/security/benchmark.test.js
- test/unit/security/content-provenance.test.js
- test/unit/security/guards/egress-guard-phase2.test.js
- test/unit/security/guards/prompt-guard-phase2.test.js
- test/unit/security/guards/secrets-guard-phase2.test.js
- test/unit/security/guards/tool-guard-phase2.test.js
- test/unit/security/provenance-annotator.test.js
- test/unit/security/response-wrapper.test.js
- test/unit/security/session-manager-flush.test.js
- test/unit/security/session-manager.test.js
- test/unit/server/command-handler-restart.test.js
- test/unit/server/command-handler.test.js
- test/unit/services/email-monitor-provenance.test.js
- test/unit/skill-forge-mocked-nc.test.js
- test/unit/skill-forge/security-scanner.test.js
- test/unit/skill-forge/template-engine.test.js
- test/unit/talk-signature-verifier.test.js
- test/unit/talk/conversation-context.test.js
- test/unit/talk/talk-send-queue.test.js
- test/unit/talk/think-tag-stripping.test.js
- test/unit/voice/speaches-client.test.js
- test/unit/workflows/gate-detector.test.js
- test/unit/workflows/workflow-board-detector.test.js
- test/unit/workflows/workflow-engine.test.js
- test/unit/workflows/workflow-model-local.test.js
