---
name: knowledge-architecture
description: >
  Moltagent's living knowledge architecture. Triggers when working on wiki pages,
  Collectives integration, entity extraction, document ingestion, the fractal index,
  WikiSteward, observation log, memory decay, or any knowledge pipeline component.
  Also triggers on: wiki, steward, fractal, knowledge, collectives, entity, ingest,
  observation, decay, compost, wikilink, index, Level 0, Level 1, neighborhood, cluster.
---

# Living Knowledge Architecture

## The Ecosystem Metaphor

Moltagent's knowledge base is an ecosystem, not a database. Wiki pages are organisms. Wikilinks are mycorrhizal connections. The knowledge graph is the nutrient cycle. Three stewards maintain it, each seeing through their own lens.

**Core principle:** In an ecosystem, each organism provides a service function, and it gives them pleasure to fulfill it. The stewards don't maintain the wiki because they're told to. Maintenance IS their purpose.

## Fractal Index (Three Levels, Self-Similar)

```
Level 0 — Landing Page: domain clusters (~15-20 lines)
  LLM clusters by MEANING, not by wiki section.
  Agent reads this FIRST on every query.

Level 1 — Section Parent Pages: entity listings
  Each entity: name, one-liner, confidence, wikilinks.

Level 2 — Entity Pages: full detail (existing)
```

Each level has the same structure: title, summary, links to children. The pattern is self-similar at every scale. Level 0 grows logarithmically — clusters are domains, not entities. 500 pages still fit in ~40 lines on Level 0.

## Three Stewards

**Knowledge Steward** — truth maintenance.
Sees: contradictions, staleness, gaps, confidence levels.
"Is what we know still true? What's missing?"

**Connection Steward** — relationship growth.
Sees: missing wikilinks, orphan pages, near-duplicates, cluster coherence.
"Is everything connected that should be connected?"

**Memory Steward** — lifecycle management.
Sees: access patterns, decay, embedding staleness, composting candidates.
"What's alive, what's dying, what should be composted?"

Stewards rotate on heartbeat ticks. Each walks one cluster per tick. The NEEDIEST cluster gets attention first (most unresolved observations + longest since last visit).

## The Observation Log

Query traversals generate FREE observations. The walk to the horticulture IS the observation of the garden. During enrichment, the agent notices issues (stale page, missing link, contradiction) and logs them without stopping to fix them. Stewards read the observation log to find work.

Observation types: contradiction, stale_content, gap, low_confidence, missing_link, orphan_page, near_duplicate, section_stale, unembedded, never_accessed, compost_ready, high_access.

## Update-on-Ingest

When a new document mentions an entity that already has a wiki page, ENRICH the existing page — don't silently skip. Knowledge compounds. Use one LLM call to check: does the new source add facts not already present? Does it contradict existing content? If yes to either, update the page and log an observation.

## Wikilinks

Every entity page should contain [[wikilinks]] to related entities. The Connection Steward adds them retroactively. The wikilink resolver converts [[EntityName]] to clickable Nextcloud URLs. Links ARE the knowledge graph made visible in the content.

## Document Intelligence Taxonomy (14 Types)

Each document type triggers a different extraction strategy:

| Type | Extract | Wiki Pages? |
|------|---------|------------|
| TRANSACTIONAL | Financial fields | No — graph only |
| AGREEMENT | Parties, terms, dates | Yes — organizations, people |
| CORRESPONDENCE | Sender, decisions, actions | Selective |
| MEETING_RECORD | Attendees, decisions, action items | Yes — people, actions to Deck |
| PLANNING | Projects, milestones, people | Yes — projects, people |
| REFERENCE | Summary only | No — document ref only |
| CREATIVE | Audience, messaging | No — document ref only |
| PEOPLE_HR | Names, roles, contacts, org structure | Yes — primary people source |
| TECHNICAL | Components, infrastructure, decisions | Yes — Components/, Infrastructure/ |
| VISUAL | OCR → reclassify | Depends on OCR content |
| DATA | Structure description, key metrics | No — document ref only |
| MEDIA | Metadata only | No |
| TEMPLATE | Nothing | Skip entirely |
| SYSTEM | Nothing (NEVER ingest secrets) | Skip entirely |

## Wiki Sections

| Section | Content | Source |
|---------|---------|-------|
| People/ | Persons | PEOPLE_HR, MEETING_RECORD, AGREEMENT |
| Organizations/ | Companies | AGREEMENT, CORRESPONDENCE |
| Projects/ | Business projects | PLANNING, MEETING_RECORD |
| Components/ | Code modules | TECHNICAL |
| Infrastructure/ | VMs, services | TECHNICAL |
| Agents/ | LLM models | TECHNICAL |
| Documents/ | File references | All types |
| Procedures/ | Workflows | Manual + PLANNING |
| Research/ | Findings | REFERENCE |
| Meta/ | System pages | Heartbeat |
| Sessions/ | Conversation history | Session persister |

## Gotchas

- **Entity names must appear VERBATIM in source text.** The LLM fabricated "CISoar Team" from the acronym "CISO". Every extracted entity name must be findable as a literal string in the source document.
- **Descriptions must paraphrase explicit statements.** No editorializing. No inferring from proximity. If the source doesn't say what an entity IS, return description: null.
- **The landing page is NOT a flat list.** It's LLM-clustered domains. Carlos and ManeraMedia belong in the same cluster even though they're in different sections.
- **Composting is archiving, not deleting.** Dead knowledge goes to Meta/Archive with a one-line summary. Original content stays in version history.
- **Protected pages are NEVER touched by stewards:** Memory Manifesto, Learning Log, Pending Questions, Knowledge Stats, Deck Task Management.
