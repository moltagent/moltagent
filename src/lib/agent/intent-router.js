/**
 * IntentRouter — Language-agnostic four-gate intent classification.
 *
 * Messages are classified into gates: knowledge (default), action
 * (user wants to DO something), compound (both), thinking (deep reflection,
 * opinion, hypotheticals), greeting, confirmation,
 * or confirmation_declined. Classification uses the LLM Router job system
 * which routes to Haiku (cloud-ok) or local models (local-only).
 * Language-specific examples are injected based on cockpit persona language.
 *
 * No English-only regex guards. The LLM handles all languages natively.
 * Emergency regex fallback (English-only) fires only when all LLM models are down.
 *
 * @module agent/intent-router
 * @version 4.0.0
 */

'use strict';

const VALID_GATES = new Set([
  'knowledge', 'action', 'compound', 'thinking'
]);

// Passthrough intents — not gates, but valid classifier outputs
const PASSTHROUGH_INTENTS = new Set([
  'greeting', 'chitchat', 'confirmation', 'confirmation_declined', 'selection', 'complex', 'unknown'
]);

// Map fine-grained intents to domain routing
const INTENT_TO_DOMAIN = {
  calendar_create: 'calendar', calendar_query: 'calendar',
  calendar_update: 'calendar', calendar_delete: 'calendar',
  deck_create: 'deck', deck_move: 'deck', deck_query: 'deck',
  wiki_write: 'wiki', wiki_read: 'wiki',
  email_send: 'email', email_read: 'email',
  file_upload: 'file', file_query: 'file',
};

const DOMAIN_INTENTS = new Set(['deck', 'calendar', 'email', 'wiki', 'file', 'search', 'knowledge']);

const COMPLEX_FALLBACK = Object.freeze({ gate: 'knowledge', intent: 'knowledge', domain: null, needsHistory: false, confidence: 0 });

const INTENT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    gate: { type: 'string' },
    domain: { type: 'string' },
    confidence: { type: 'number' }
  },
  required: ['gate']
});

const CLASSIFICATION_EXAMPLES = {
  EN: {
    action: `
  Examples:
  "Create a board for content planning" → action, domain: deck
  "Send an email to Carlos" → action, domain: email
  "Book a meeting for Tuesday at 3pm" → action, domain: calendar
  "Move the onboarding card to Done" → action, domain: deck
  "Give it the due date tomorrow" → action, domain: deck
  "Set the deadline to Friday" → action, domain: deck
  "Save this to the wiki" → action, domain: wiki
  "Upload the report" → action, domain: file`,
    compound: `
  Examples:
  "Check if Carlos is available Tuesday and book a meeting" → compound, domain: calendar
  "What's the status of onboarding and create a follow-up task" → compound, domain: deck`,
    knowledge: `
  Examples:
  "Who is Carlos?" → knowledge
  "What's the status of onboarding?" → knowledge
  "What boards do I have?" → knowledge
  "What's the weather in Lisbon?" → knowledge`,
    thinking: `
  Examples:
  "What do you think about our architecture?" → thinking
  "If you could redesign X, how would you?" → thinking
  "Think deeply about what this means" → thinking
  "What's your honest assessment of..." → thinking
  "Reflect on your role in the team" → thinking
  "What does sovereignty mean for you?" → thinking
  "If you could change one thing about yourself..." → thinking`,
    greeting: `
  Examples:
  "Hi" / "Hello" / "Good morning" / "Hey there" → greeting`
  },
  DE: {
    action: `
  Beispiele:
  "Erstelle ein Board für Content-Planung" → action, domain: deck
  "Schicke Carlos eine E-Mail" → action, domain: email
  "Buche ein Meeting für Dienstag um 15 Uhr" → action, domain: calendar
  "Verschiebe die Onboarding-Karte nach Erledigt" → action, domain: deck
  "Setze die Frist auf Freitag" → action, domain: deck
  "Gib ihr das Fälligkeitsdatum morgen" → action, domain: deck
  "Speichere das im Wiki" → action, domain: wiki
  "Lade den Bericht hoch" → action, domain: file`,
    compound: `
  Beispiele:
  "Prüfe ob Carlos am Dienstag verfügbar ist und buche ein Meeting" → compound, domain: calendar
  "Was ist der Stand beim Onboarding und erstelle eine Folgeaufgabe" → compound, domain: deck`,
    knowledge: `
  Beispiele:
  "Wer ist Carlos?" → knowledge
  "Wie ist der Stand beim Onboarding?" → knowledge
  "Welche Boards habe ich?" → knowledge
  "Wie ist das Wetter in Berlin?" → knowledge`,
    thinking: `
  Beispiele:
  "Was denkst du über unsere Architektur?" → thinking
  "Wenn du X neu entwerfen könntest, wie würdest du?" → thinking
  "Denk mal gründlich darüber nach" → thinking
  "Was ist deine ehrliche Einschätzung von..." → thinking
  "Reflektiere über deine Rolle im Team" → thinking
  "Was bedeutet Souveränität für dich?" → thinking`,
    greeting: `
  Beispiele:
  "Hallo" / "Guten Morgen" / "Moin" / "Servus" → greeting`
  },
  PT: {
    action: `
  Exemplos:
  "Cria um board para planeamento de conteúdo" → action, domain: deck
  "Envia um email ao Carlos" → action, domain: email
  "Marca uma reunião para terça às 15h" → action, domain: calendar
  "Move o cartão de onboarding para Concluído" → action, domain: deck
  "Define o prazo para sexta-feira" → action, domain: deck
  "Guarda isto no wiki" → action, domain: wiki
  "Carrega o relatório" → action, domain: file`,
    compound: `
  Exemplos:
  "Verifica se o Carlos está disponível terça e marca uma reunião" → compound, domain: calendar
  "Qual é o estado do onboarding e cria uma tarefa de follow-up" → compound, domain: deck`,
    knowledge: `
  Exemplos:
  "Quem é o Carlos?" → knowledge
  "Qual é o estado do onboarding?" → knowledge
  "Que boards é que tenho?" → knowledge
  "Como está o tempo em Lisboa?" → knowledge`,
    thinking: `
  Exemplos:
  "O que achas da nossa arquitetura?" → thinking
  "Se pudesses redesenhar X, como farias?" → thinking
  "Pensa profundamente sobre o que isto significa" → thinking
  "Qual é a tua avaliação honesta de..." → thinking
  "Reflete sobre o teu papel na equipa" → thinking
  "O que significa soberania para ti?" → thinking`,
    greeting: `
  Exemplos:
  "Olá" / "Bom dia" / "Boa tarde" / "E aí" → greeting`
  },
  FR: {
    action: `
  Exemples:
  "Crée un board pour la planification de contenu" → action, domain: deck
  "Envoie un email à Carlos" → action, domain: email
  "Réserve une réunion pour mardi à 15h" → action, domain: calendar
  "Déplace la carte d'onboarding vers Terminé" → action, domain: deck
  "Sauvegarde ça dans le wiki" → action, domain: wiki`,
    compound: `
  Exemples:
  "Vérifie si Carlos est disponible mardi et réserve une réunion" → compound, domain: calendar`,
    knowledge: `
  Exemples:
  "Qui est Carlos ?" → knowledge
  "Quel est le statut de l'onboarding ?" → knowledge
  "Quel temps fait-il à Paris ?" → knowledge`,
    thinking: `
  Exemples:
  "Que penses-tu de notre architecture ?" → thinking
  "Si tu pouvais redesigner X, comment ferais-tu ?" → thinking
  "Réfléchis profondément à ce que cela signifie" → thinking
  "Quelle est ton évaluation honnête de..." → thinking`,
    greeting: `
  Exemples:
  "Bonjour" / "Salut" / "Bonsoir" → greeting`
  },
  ES: {
    action: `
  Ejemplos:
  "Crea un board para planificación de contenido" → action, domain: deck
  "Envía un email a Carlos" → action, domain: email
  "Reserva una reunión para el martes a las 15h" → action, domain: calendar
  "Mueve la tarjeta de onboarding a Hecho" → action, domain: deck
  "Guarda esto en el wiki" → action, domain: wiki`,
    compound: `
  Ejemplos:
  "Comprueba si Carlos está disponible el martes y reserva una reunión" → compound, domain: calendar`,
    knowledge: `
  Ejemplos:
  "¿Quién es Carlos?" → knowledge
  "¿Cuál es el estado del onboarding?" → knowledge
  "¿Qué tiempo hace en Madrid?" → knowledge`,
    thinking: `
  Ejemplos:
  "¿Qué piensas de nuestra arquitectura?" → thinking
  "Si pudieras rediseñar X, ¿cómo lo harías?" → thinking
  "Piensa profundamente sobre lo que esto significa" → thinking
  "¿Cuál es tu evaluación honesta de...?" → thinking`,
    greeting: `
  Ejemplos:
  "Hola" / "Buenos días" / "Buenas tardes" → greeting`
  }
};

/**
 * Build a language-aware classification prompt.
 * When the cockpit language is not English, examples are provided in that language
 * so the LLM naturally handles intent detection for non-English messages.
 *
 * @param {string} language - ISO language code (EN, DE, PT, FR, ES, etc.)
 * @returns {string} Classification system prompt
 */
function buildClassificationPrompt(language = 'EN') {
  const lang = (language || 'EN').toUpperCase().split('+')[0].trim();

  // Language-specific examples
  const examples = CLASSIFICATION_EXAMPLES[lang] || CLASSIFICATION_EXAMPLES.EN;

  return `Classify the LAST user message into exactly ONE category.

ACTION — The user wants you to DO something.
  The message contains a clear action verb (in any language):
  create, send, book, move, update, delete, remind, upload, save, write, remember, forget...
${examples.action}

COMPOUND — The user wants BOTH knowledge AND action in one message.
  Contains a question AND an action request connected by "and", "then", etc.
${examples.compound}

THINKING — The user wants deep reflection, analysis, opinion, or hypothetical reasoning.
  NOT a factual lookup. NOT a status check. The user wants you to THINK, not retrieve.
  Signals: "think about", "reflect on", "what do you think", "your opinion", "your assessment",
  "what does X mean for you", "if you could...", hypothetical questions, philosophical questions,
  questions about the agent's own nature, identity, or capabilities.
${examples.thinking}

KNOWLEDGE — Factual questions, lookups, status checks. THIS IS THE DEFAULT.
  The user wants to know something. Any question. Any lookup. Anything ambiguous.
${examples.knowledge}

GREETING — A greeting, farewell, or simple social pleasantry.
${examples.greeting}

CONFIRMATION — Short affirmative reply after the agent offered to do something.
  yes, yeah, sure, ok, do it, go ahead, please (in any language)
  Return: {"gate": "confirmation", "confidence": 0.8}

CONFIRMATION_DECLINED — Short negative reply declining an agent offer.
  no, nah, nope, cancel, stop, don't (in any language)
  Return: {"gate": "confirmation_declined", "confidence": 0.8}

THE CRITICAL TEST:
  Does the message contain an ACTION VERB (create, send, move, book, delete, remind...)?
    YES + no question → action
    YES + also a question → compound
    NO → is the user asking you to THINK, reflect, or give an opinion? → thinking
    NO → knowledge (factual, lookup, status)
  When in doubt → knowledge. Always safe.

CONTEXT-AWARE RULES:
- Read the <conversation> block FIRST. The user's message usually continues the current topic.
- If the assistant just showed calendar results, the user is probably still talking about calendar.
- If the assistant just listed Deck cards, the user is probably still talking about Deck.
- If the assistant just listed files, the user is probably still talking about files.
- If the message references something from the conversation ("that one", "delete it", "the first", "move it to done"), classify based on what the conversation was about.
- When uncertain, prefer the domain of the most recent assistant action for continuations.
- When uncertain and NOT continuing a conversation, prefer knowledge.

Return JSON:
{
  "gate": "knowledge" | "action" | "compound" | "thinking" | "greeting" | "chitchat" | "confirmation" | "confirmation_declined",
  "domain": "deck" | "calendar" | "email" | "wiki" | "file" | null,
  "confidence": 0.0-1.0
}

domain is only set when gate is "action" or "compound".
Respond with JSON only.`;
}

class IntentRouter {
  /**
   * @param {Object} opts
   * @param {Object} opts.provider - OllamaToolsProvider (uses .chat() with model override)
   * @param {Object} [opts.llmRouter] - LLMRouter instance for job-based routing
   * @param {Function} [opts.getLanguage] - Returns current cockpit language (e.g. 'EN', 'DE')
   * @param {Object} [opts.config]
   * @param {number} [opts.config.classifyTimeout=10000]
   * @param {string} [opts.config.fastModel='qwen2.5:3b'] - Fast model for explicit intents
   * @param {string} [opts.config.smartModel='qwen3:8b'] - Smart model for ambiguous intents
   */
  constructor({ provider, config = {}, getLanguage, llmRouter } = {}) {
    this.provider = provider;
    this.llmRouter = llmRouter || null;
    this.timeout = config.classifyTimeout || 10000;
    this.fastModel = config.fastModel || 'qwen2.5:3b';
    this.smartModel = config.smartModel || 'qwen3:8b';
    this.getLanguage = getLanguage || (() => 'EN');
  }

  /**
   * Classify a user message into an intent using the LLM Router or direct Ollama.
   *
   * 1. Routes via LLM Router job system when available (Haiku/local based on trust)
   * 2. Falls back to direct Ollama with fast model first, smart model on low confidence
   * 3. Both fail → regex fallback (English-only emergency path)
   *
   * @param {string} message - User message text
   * @param {Array} [recentContext=[]] - Last 6 context entries (3 exchanges)
   * @param {Object} [context={}] - { replyFn } for thinking indicator
   * @returns {Promise<{intent: string, domain: string|null, needsHistory: boolean, confidence: number}>}
   */
  async classify(message, recentContext = [], _context = {}) {
    message = message || '';

    try {
      // Primary: route through LLM Router job system when available
      if (this.llmRouter) {
        return await this._classifyViaRouter(message, recentContext);
      }

      // Fallback: direct to Ollama provider (fast model first, escalate on low confidence)
      const result = await this._classifyWithModel(this.fastModel, message, recentContext);

      // If fast model returns unknown/zero-confidence, retry with smart model
      if ((result.gate === 'knowledge' && result.confidence === 0) || result.gate === 'unknown') {
        try {
          return await this._classifyWithModel(this.smartModel, message, recentContext);
        } catch (_retryErr) {
          return this._regexFallback(message);
        }
      }

      return result;
    } catch (err) {
      // Primary path failed — try smart model directly
      try {
        return await this._classifyWithModel(this.smartModel, message, recentContext);
      } catch (_fallbackErr) {
        // Both models failed — regex fallback (English-only emergency path)
        return this._regexFallback(message);
      }
    }
  }

  /**
   * Classify via the LLM Router job system.
   * Routes to Haiku (cloud-ok) or ollama-fast (local-only) based on trust.
   * @private
   */
  async _classifyViaRouter(message, recentContext = []) {
    const userContent = this._buildUserContent(message, recentContext);
    const language = this.getLanguage();
    const prompt = buildClassificationPrompt(language);

    const content = prompt + '\n\nMessage to classify:\n' + userContent;
    const result = await this.llmRouter.route({
      job: 'classification',
      task: 'classify',
      content,
      requirements: { maxTokens: 200, temperature: 0.1 }
    });

    const raw = result?.result || result?.content || '';
    return this._parseClassification(raw);
  }

  /**
   * Classify with a specific model.
   *
   * @param {string} model - Ollama model name
   * @param {string} message - User message
   * @param {Array} recentContext - Recent conversation context
   * @returns {Promise<{intent: string, domain: string|null, needsHistory: boolean, confidence: number}>}
   * @private
   */
  async _classifyWithModel(model, message, recentContext = []) {
    const userContent = this._buildUserContent(message, recentContext);
    const timeout = model === this.smartModel ? this.timeout * 4 : this.timeout;

    const result = await this.provider.chat({
      model,
      system: buildClassificationPrompt(this.getLanguage()),
      messages: [{ role: 'user', content: userContent }],
      timeout,
      format: INTENT_SCHEMA,
      options: {
        num_ctx: 2048,
        temperature: 0.1
      }
    });

    return this._parseClassification(result.content || '');
  }

  /**
   * Build the user content string with optional conversation context.
   * @param {string} message
   * @param {Array} recentContext
   * @returns {string}
   * @private
   */
  _buildUserContent(message, recentContext) {
    let contextBlock = '';
    if (recentContext.length > 0) {
      const formatted = recentContext.slice(-6).map(c => {
        const safe = (typeof c.content === 'string' ? c.content : String(c.content || '')).substring(0, 200).replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `${c.role}: ${safe}`;
      }).join('\n');
      contextBlock = `\n<conversation>\n${formatted}\n</conversation>\n\n`;
    }

    return `${contextBlock}${message.substring(0, 300)}`;
  }

  /**
   * English-only emergency regex fallback when all LLM models are unavailable.
   * Non-English messages get safe 'knowledge' default routing.
   * This is a degraded-mode path — not expected in normal operation.
   * @param {string} message
   * @returns {{gate: string, intent: string, domain: string|null, needsHistory: boolean, confidence: number, compound: boolean}}
   * @private
   */
  _regexFallback(message) {
    const lower = message.toLowerCase().trim();

    // Action verb detection
    // Note: "schedule" as verb ("schedule a meeting") vs noun ("my schedule") is ambiguous.
    // We include it here and rely on the knowledge patterns below to catch "what's on my schedule".
    const hasActionVerb = /\b(create|make|set\s+up|build|send|draft|compose|reply|book|schedule\s+(a|an|the|my)|move|assign|update|delete|remove|remind|add|upload|download|save|store|forward|write|remember|forget)\b/.test(lower);

    // Compound detection: action verb + connector + another operation
    const compound = hasActionVerb && (
      /\b(and\s+(then\s+)?(check|create|find|send|book|search|move|list|remind|look|tell|show))\b/.test(lower) ||
      /\b(if\s+(not|no|none|empty|nothing)|then\s+(create|send|book|remind|add|move))\b/.test(lower) ||
      /,\s*(and\s+)?(check|create|find|send|book|search|move|list|remind|look|tell|show)\b/.test(lower)
    );

    // Domain detection
    let domain = null;
    if (/\b(schedule\w*|calendar|events?|meetings?|appointments?|agenda)\b/.test(lower)) domain = 'calendar';
    else if (/\b(emails?|mail|inbox)\b/.test(lower)) domain = 'email';
    else if (/\b(tasks?|cards?|boards?|deck|todos?|move\b.+\b(to done|to doing|to inbox|to working|to queued))\b/.test(lower)) domain = 'deck';
    else if (/\b(wiki|page|knowledge|note)\b/.test(lower)) domain = 'wiki';
    else if (/\b(file|folder|document|upload|download)\b/.test(lower)) domain = 'file';

    // Route based on action verb presence
    if (hasActionVerb && domain) {
      const gate = compound ? 'compound' : 'action';
      return {
        gate, intent: domain,
        domain, needsHistory: false, confidence: 0.5, compound
      };
    }

    // Knowledge queries — questions about people, projects, status
    if (/\b(who is|what is|what'?s|what do you know|tell me about|what about|do i have|show me|any .{0,20}(today|tomorrow|this week|next week)|summarize|how does|how do)\b/.test(lower)) {
      return { gate: 'knowledge', intent: 'knowledge', domain: null, needsHistory: false, confidence: 0.5, compound: false };
    }

    // Memory language → action:wiki (remember/forget are action verbs)
    if (/\b(remember|forget|forgot|told you|decision|stored)\b/.test(lower)) {
      return { gate: 'action', intent: 'wiki', domain: 'wiki', needsHistory: false, confidence: 0.5, compound: false };
    }

    // Short messages → greeting/chitchat
    if (lower.split(/\s+/).length <= 8) {
      return { gate: 'chitchat', intent: 'chitchat', domain: null, needsHistory: false, confidence: 0.4, compound: false };
    }

    // Default: knowledge (NOT complex — knowledge is always the safe default)
    return { gate: 'knowledge', intent: 'knowledge', domain: null, needsHistory: false, confidence: 0.3, compound: false };
  }

  /**
   * Parse LLM classification response into structured result.
   * Handles both three-gate format (gate/domain) and legacy intent format.
   * @param {string} content - Raw LLM response
   * @returns {{gate: string, intent: string, domain: string|null, needsHistory: boolean, confidence: number, compound: boolean}}
   * @private
   */
  _parseClassification(content) {
    // Strip think tags and markdown fences
    let cleaned = content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```(?:json)?\s*/g, '')
      .replace(/```/g, '')
      .trim();

    // Extract JSON object
    const match = cleaned.match(/\{[^}]+\}/);
    if (!match) return { ...COMPLEX_FALLBACK };

    try {
      const parsed = JSON.parse(match[0]);
      let gate = (parsed.gate || '').toLowerCase().trim();
      let domain = (parsed.domain || '').toLowerCase().trim() || null;
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.8;

      // Legacy format: LLM returned {"intent":"..."} instead of {"gate":"..."}
      if (!gate && parsed.intent) {
        const intent = parsed.intent.toLowerCase().trim();
        if (intent === 'knowledge') {
          gate = 'knowledge';
        } else if (INTENT_TO_DOMAIN[intent]) {
          gate = 'action';
          domain = INTENT_TO_DOMAIN[intent];
        } else if (DOMAIN_INTENTS.has(intent)) {
          gate = 'action';
          domain = intent;
        } else if (PASSTHROUGH_INTENTS.has(intent)) {
          gate = intent;
        } else {
          return { ...COMPLEX_FALLBACK, compound: parsed.compound === true };
        }
      }

      // Validate gate
      if (!gate || (!VALID_GATES.has(gate) && !PASSTHROUGH_INTENTS.has(gate))) {
        return { ...COMPLEX_FALLBACK, compound: parsed.compound === true };
      }

      const compound = gate === 'compound' || parsed.compound === true;

      // Unknown → knowledge (knowledge is the safe default)
      if (gate === 'unknown') {
        gate = 'knowledge';
        domain = null;
      }

      // Build result based on gate
      let result;
      if (gate === 'action') {
        result = { gate: 'action', domain: domain || null, needsHistory: false, confidence, compound };
      } else if (gate === 'compound') {
        result = { gate: 'compound', domain: domain || null, needsHistory: false, confidence, compound: true };
      } else if (gate === 'knowledge') {
        result = { gate: 'knowledge', domain: null, needsHistory: false, confidence, compound };
      } else if (gate === 'confirmation' || gate === 'confirmation_declined' || gate === 'selection') {
        result = { gate, domain: null, needsHistory: gate === 'confirmation' || gate === 'selection', confidence, compound };
      } else if (gate === 'complex') {
        result = { gate: 'complex', domain: null, needsHistory: true, confidence: Math.min(confidence, 0.7), compound };
      } else {
        // greeting, chitchat
        result = { gate, domain: null, needsHistory: false, confidence, compound };
      }

      // Backward-compat shim: code reading result.intent still works
      // action → domain name, compound → domain name, others → gate name
      result.intent = (result.gate === 'action' || result.gate === 'compound')
        ? (result.domain || 'complex')
        : result.gate;

      return result;
    } catch {
      return { ...COMPLEX_FALLBACK };
    }
  }

}

// Export class and static helpers
IntentRouter.buildClassificationPrompt = buildClassificationPrompt;
IntentRouter.CLASSIFICATION_EXAMPLES = CLASSIFICATION_EXAMPLES;
IntentRouter.VALID_GATES = VALID_GATES;

module.exports = IntentRouter;
