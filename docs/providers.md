# LLM Providers

Moltagent is provider-agnostic. The routing system supports 13 adapters out of the box, routes different types of work to different models, and falls back to local inference when cloud providers are unavailable.

## Presets

Three presets control the overall routing strategy. Switch between them via the Cockpit (Deck control plane) or configuration.

| Preset | Cockpit Name | Behavior |
|--------|-------------|----------|
| **all-local** | Local Only | All jobs routed to Ollama. Zero cloud cost. Full sovereignty. |
| **smart-mix** | Balanced | Cloud primary with local fallback. Cost-optimized per job type. |
| **cloud-first** | Premium | Cloud only, no local fallback. Maximum quality. |

**Hard rule across all presets:** credential operations always stay local. Secrets never leave your infrastructure, regardless of which preset you choose.

**Fallback rule:** all presets fall back to local when cloud is unavailable. If your API key expires, the provider has an outage, or your daily budget is exhausted, the agent degrades to local models. Simpler, slower, but never dark.

## Job-Based Routing

The agent classifies every LLM call by job type and routes to the appropriate model. This means a simple classification task uses a cheap/fast model, while a complex writing task uses a capable one.

| Job | Purpose | Provider Chain (smart-mix) |
|-----|---------|--------------------------|
| **quick** | Chat, summaries, email classification | Haiku, then local |
| **classification** | Intent detection, routing decisions | Haiku, then local |
| **synthesis** | Comprehension, entity extraction | Haiku, then local |
| **decomposition** | Compound intent splitting | Haiku, then local |
| **tools** | Structured tool calls, calendar/email parsing | Haiku, then local |
| **research** | Knowledge queries, meeting prep | Haiku, then local |
| **coding** | Code generation | Sonnet, then Haiku, then local |
| **writing** | Email drafts, long-form content | Opus, then Sonnet, then Haiku, then local |
| **thinking** | Deep reasoning, admin tasks, follow-ups | Opus, then Sonnet, then Haiku, then local |
| **credentials** | Credential operations (secrets) | **Local only, always** |

Each chain is a fallback sequence. If the first provider fails or is over budget, the next one is tried. Every chain ends with a local model ("never dark" guarantee).

## Supported Providers

| Adapter | Default Model | Input $/1M tokens | Output $/1M tokens |
|---------|--------------|-------------------|-------------------|
| Anthropic | claude-sonnet-4 | $3.00 | $15.00 |
| OpenAI | gpt-4o | $2.50 | $10.00 |
| Google | gemini-1.5-flash | $0.075 | $0.30 |
| DeepSeek | deepseek-chat | $0.14 | $0.28 |
| Mistral | mistral-small-latest | $0.20 | $0.60 |
| Groq | llama-3.3-70b | $0.59 | $0.79 |
| Perplexity | sonar-pro | $3.00 | $15.00 |
| OpenRouter | claude-sonnet-4 | $3.00 | $15.00 |
| xAI | grok-3 | $3.00 | $15.00 |
| Together | llama-3-70b | $0.90 | $0.90 |
| Fireworks | llama-3.1-70b | $0.90 | $0.90 |
| OpenAI-Compatible | (configurable) | varies | varies |
| Ollama (local) | qwen3:8b / qwen2.5:3b | free | free |

Pricing as of early 2026. Check provider websites for current rates.

Cloud providers are auto-classified by cost tier:
- **Heavy** (most expensive) - used for thinking and writing jobs
- **Workhorse** (mid-tier) - used for coding jobs
- **Cheapest** - used for tools, classification, and quick jobs

## Adding Your Own Provider

Moltagent uses a YAML-based provider configuration. To add a new provider:

1. Add the provider to your `moltagent-providers.yaml`:

```yaml
providers:
  my-provider:
    adapter: openai-compatible
    baseUrl: https://api.my-provider.com/v1
    credentialName: my-provider-api-key
    defaultModel: my-model-name
    costPer1kInput: 0.001
    costPer1kOutput: 0.002
```

2. Store the API key in NC Passwords and share it with the `moltagent` user
3. Reference the provider in your job routing chains

The `openai-compatible` adapter works with any provider that implements the OpenAI chat completions API.

## Cost Control

### Budget Enforcement

The BudgetEnforcer tracks spending in real time:

- **Daily limits** per model and per provider, configurable via the Cockpit
- **Automatic degradation** to local Ollama when budget is exhausted
- **Cost notifications** posted to NC Talk when thresholds are approached
- **Full transparency** in the Cockpit showing current spend vs. budget

### Cost Optimization Tips

- Use the **smart-mix** preset for the best cost/quality balance
- Most routine work (classification, tool calls, simple queries) runs on the cheapest available model
- Only writing and deep thinking tasks use premium models
- Monitor your daily spend in the Cockpit and adjust limits based on actual usage patterns
- If you primarily need simple workflows, the **all-local** preset with qwen3:8b handles categorization, routing, and basic task management at zero cost

## Resilience

The routing system includes:

- **Circuit breakers** - if a provider fails repeatedly, it's temporarily removed from the chain to avoid wasting time and tokens on retries
- **Backoff strategy** - exponential backoff with loop detection
- **Rate limit tracking** - respects provider rate limits and queues requests
- **Graceful degradation** - budget exhaustion and provider failures always fall back to local, never to errors

The design goal: your agent should never stop working because of an external provider issue. Quality may degrade, but availability is preserved.
