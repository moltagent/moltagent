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
 * The verdict states four facts about the message, each with exactly one
 * meaning: `gate` (which pipeline it needs), `domain` (which tools), `language`
 * (what the user wrote in), and `expectsMutation` (whether they want state
 * changed or want to be told something). The last two exist because the first
 * was carrying their meanings too: `gate=action` doubled as "wants a mutation"
 * (#272) and `language` named the persona rather than the person (#273).
 *
 * No English-only regex guards. The LLM handles all languages natively.
 * Emergency regex fallback (English-only) fires only when all LLM models are down.
 *
 * @module agent/intent-router
 * @version 5.0.0
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

// The four language tags the verdict may carry. Anything else is OTHER — the
// classifier never invents a fifth tag, and OTHER falls back to the persona.
const VALID_LANGUAGES = new Set(['EN', 'DE', 'PT', 'OTHER']);

const INTENT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    gate: { type: 'string' },
    domain: { type: 'string' },
    language: { type: 'string' },
    expectsMutation: { type: 'boolean' },
    confidence: { type: 'number' }
  },
  required: ['gate']
});

const CLASSIFICATION_EXAMPLES = {
  EN: {
    action: `
  Examples:
  "Create a board for content planning" → action, domain: deck
  "Send an email to Alex" → action, domain: email
  "Book a meeting for Tuesday at 3pm" → action, domain: calendar
  "Do I have events today?" → action, domain: calendar
  "What's on my calendar this week?" → action, domain: calendar
  "Am I free at 3pm?" → action, domain: calendar
  "When is my next meeting?" → action, domain: calendar
  "Move the onboarding card to Done" → action, domain: deck
  "Give it the due date tomorrow" → action, domain: deck
  "Set the deadline to Friday" → action, domain: deck
  "Do I have any open tasks?" → action, domain: deck
  "What's on my board?" → action, domain: deck
  "Which boards do I have?" → action, domain: deck
  "Show me overdue tasks" → action, domain: deck
  "Save this to the wiki" → action, domain: wiki
  "Upload the report" → action, domain: file`,
    compound: `
  Examples:
  "Check if Alex is available Tuesday and book a meeting" → compound, domain: calendar
  "What's the status of onboarding and create a follow-up task" → compound, domain: deck
  "Research what Analytics can do. Create a card with the findings." → compound, domain: deck
  "What does Nextcloud Forms do? Put it on a Deck card for me." → compound, domain: deck
  "Look into the project status. Send me a summary by email." → compound, domain: email`,
    knowledge: `
  Examples (ALL factual questions are knowledge — "What is X?", "Who does X?", "How does X work?"):
  "Who is Alex?" → knowledge
  "What's the status of onboarding?" → knowledge
  "What's the weather in Lisbon?" → knowledge
  "What is HeartbeatManager?" → knowledge
  "Who works on Moltagent?" → knowledge
  "How does document ingestion work?" → knowledge
  "Explain the trust boundary to me" → knowledge
  "What can you do?" → knowledge
  "What is AutoAgent?" → knowledge
  "Tell me about the memory architecture" → knowledge`,
    thinking: `
  Examples (ONLY explicit reflection, opinion, or hypothetical — never factual questions):
  "Think deeply about what Moltagent means" → thinking
  "What's your honest assessment of our progress?" → thinking
  "Reflect on your own capabilities" → thinking
  "If you could redesign the memory system, how would you?" → thinking
  "What does sovereignty mean to you personally?" → thinking`,
    greeting: `
  Examples:
  "Hi" / "Hello" / "Good morning" / "Hey there" → greeting`
  },
  DE: {
    action: `
  Beispiele:
  "Erstelle ein Board für Content-Planung" → action, domain: deck
  "Schicke Alex eine E-Mail" → action, domain: email
  "Buche ein Meeting für Dienstag um 15 Uhr" → action, domain: calendar
  "Habe ich heute Termine?" → action, domain: calendar
  "Was steht diese Woche im Kalender?" → action, domain: calendar
  "Bin ich um 15 Uhr frei?" → action, domain: calendar
  "Wann ist mein nächstes Meeting?" → action, domain: calendar
  "Verschiebe die Onboarding-Karte nach Erledigt" → action, domain: deck
  "Setze die Frist auf Freitag" → action, domain: deck
  "Gib ihr das Fälligkeitsdatum morgen" → action, domain: deck
  "Habe ich offene Aufgaben?" → action, domain: deck
  "Was ist auf meinem Board?" → action, domain: deck
  "Welche Boards habe ich?" → action, domain: deck
  "Zeig mir überfällige Aufgaben" → action, domain: deck
  "Speichere das im Wiki" → action, domain: wiki
  "Lade den Bericht hoch" → action, domain: file`,
    compound: `
  Beispiele:
  "Prüfe ob Alex am Dienstag verfügbar ist und buche ein Meeting" → compound, domain: calendar
  "Was ist der Stand beim Onboarding und erstelle eine Folgeaufgabe" → compound, domain: deck
  "Recherchiere was Analytics kann. Schreib die Ergebnisse auf eine Karte." → compound, domain: deck
  "Was macht Nextcloud Forms? Pack es auf eine Deck-Karte." → compound, domain: deck`,
    knowledge: `
  Beispiele (ALLE Sachfragen sind knowledge — "Was ist X?", "Wer macht X?", "Wie funktioniert X?"):
  "Wer ist Alex?" → knowledge
  "Wie ist der Stand beim Onboarding?" → knowledge
  "Wie ist das Wetter in Berlin?" → knowledge
  "Was ist der HeartbeatManager?" → knowledge
  "Wer arbeitet an Moltagent?" → knowledge
  "Wie funktioniert die Dokumentenverarbeitung?" → knowledge
  "Erkläre mir das Deck-System" → knowledge`,
    thinking: `
  Beispiele (NUR explizite Reflexion, Meinung oder hypothetische Fragen — niemals Sachfragen):
  "Was denkst du wirklich über unsere Architektur?" → thinking
  "Reflektiere über deine Fähigkeiten" → thinking
  "Wenn du das System neu entwerfen könntest, wie?" → thinking
  "Was bedeutet Souveränität für dich persönlich?" → thinking`,
    greeting: `
  Beispiele:
  "Hallo" / "Guten Morgen" / "Moin" / "Servus" → greeting`
  },
  PT: {
    action: `
  Exemplos:
  "Cria um board para planeamento de conteúdo" → action, domain: deck
  "Envia um email ao Alex" → action, domain: email
  "Marca uma reunião para terça às 15h" → action, domain: calendar
  "Tenho eventos hoje?" → action, domain: calendar
  "O que tenho no calendário esta semana?" → action, domain: calendar
  "Estou livre às 15h?" → action, domain: calendar
  "Quando é a minha próxima reunião?" → action, domain: calendar
  "Move o cartão de onboarding para Concluído" → action, domain: deck
  "Define o prazo para sexta-feira" → action, domain: deck
  "Tenho tarefas em aberto?" → action, domain: deck
  "O que está no meu board?" → action, domain: deck
  "Que boards é que tenho?" → action, domain: deck
  "Mostra tarefas atrasadas" → action, domain: deck
  "Guarda isto no wiki" → action, domain: wiki
  "Carrega o relatório" → action, domain: file`,
    compound: `
  Exemplos:
  "Verifica se o Alex está disponível terça e marca uma reunião" → compound, domain: calendar
  "Qual é o estado do onboarding e cria uma tarefa de follow-up" → compound, domain: deck
  "Pesquisa o que o Analytics faz. Cria um cartão com os resultados." → compound, domain: deck
  "O que faz o Nextcloud Forms? Põe num cartão do Deck." → compound, domain: deck`,
    knowledge: `
  Exemplos (TODAS as perguntas factuais são knowledge — "O que é X?", "Quem faz X?", "Como funciona X?"):
  "Quem é o Alex?" → knowledge
  "Qual é o estado do onboarding?" → knowledge
  "Como está o tempo em Lisboa?" → knowledge
  "O que é o HeartbeatManager?" → knowledge
  "Como funciona a ingestão de documentos?" → knowledge
  "Me explica a arquitetura de memória" → knowledge`,
    thinking: `
  Exemplos (APENAS reflexão explícita, opinião ou hipotéticos — nunca perguntas factuais):
  "O que achas sobre o Moltagent? Pensa bem." → thinking
  "Reflita sobre o que significa ser um agente soberano" → thinking
  "Se pudesses redesenhar X, como farias?" → thinking
  "Qual é a tua avaliação honesta do nosso progresso?" → thinking`,
    greeting: `
  Exemplos:
  "Olá" / "Bom dia" / "Boa tarde" / "E aí" → greeting`
  },
  FR: {
    action: `
  Exemples:
  "Crée un board pour la planification de contenu" → action, domain: deck
  "Envoie un email à Alex" → action, domain: email
  "Réserve une réunion pour mardi à 15h" → action, domain: calendar
  "Déplace la carte d'onboarding vers Terminé" → action, domain: deck
  "Sauvegarde ça dans le wiki" → action, domain: wiki`,
    compound: `
  Exemples:
  "Vérifie si Alex est disponible mardi et réserve une réunion" → compound, domain: calendar
  "Recherche ce que fait Analytics. Crée une carte avec les résultats." → compound, domain: deck`,
    knowledge: `
  Exemples (TOUTES les questions factuelles sont knowledge — "Qu'est-ce que X ?", "Qui fait X ?", "Comment fonctionne X ?"):
  "Qui est Alex ?" → knowledge
  "Quel est le statut de l'onboarding ?" → knowledge
  "Quel temps fait-il à Paris ?" → knowledge
  "Qu'est-ce que le HeartbeatManager ?" → knowledge
  "Comment fonctionne l'ingestion de documents ?" → knowledge`,
    thinking: `
  Exemples (UNIQUEMENT réflexion explicite, opinion ou hypothétique — jamais des questions factuelles):
  "Que penses-tu vraiment de notre architecture ?" → thinking
  "Réfléchis profondément à ce que cela signifie" → thinking
  "Si tu pouvais redesigner X, comment ferais-tu ?" → thinking`,
    greeting: `
  Exemples:
  "Bonjour" / "Salut" / "Bonsoir" → greeting`
  },
  ES: {
    action: `
  Ejemplos:
  "Crea un board para planificación de contenido" → action, domain: deck
  "Envía un email a Alex" → action, domain: email
  "Reserva una reunión para el martes a las 15h" → action, domain: calendar
  "Mueve la tarjeta de onboarding a Hecho" → action, domain: deck
  "Guarda esto en el wiki" → action, domain: wiki`,
    compound: `
  Ejemplos:
  "Comprueba si Alex está disponible el martes y reserva una reunión" → compound, domain: calendar
  "Investiga qué hace Analytics. Crea una tarjeta con los resultados." → compound, domain: deck`,
    knowledge: `
  Ejemplos (TODAS las preguntas factuales son knowledge — "¿Qué es X?", "¿Quién hace X?", "¿Cómo funciona X?"):
  "¿Quién es Alex?" → knowledge
  "¿Cuál es el estado del onboarding?" → knowledge
  "¿Qué tiempo hace en Madrid?" → knowledge
  "¿Qué es el HeartbeatManager?" → knowledge
  "¿Cómo funciona la ingesta de documentos?" → knowledge`,
    thinking: `
  Ejemplos (SOLO reflexión explícita, opinión o hipotéticos — nunca preguntas factuales):
  "¿Qué piensas realmente de nuestra arquitectura?" → thinking
  "Piensa profundamente sobre lo que esto significa" → thinking
  "Si pudieras rediseñar X, ¿cómo lo harías?" → thinking`,
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
  Two or more distinct intents in the same message, whether connected by "and"/"then" or as separate sentences.
${examples.compound}

KNOWLEDGE — Factual questions, lookups, status checks. THIS IS THE DEFAULT.
  ANY question about facts, people, components, projects, status, or how things work.
  "What is X?" → ALWAYS knowledge. "Who does X?" → ALWAYS knowledge.
  "How does X work?" → ALWAYS knowledge. "Explain X" → ALWAYS knowledge.
  When in doubt → knowledge.
${examples.knowledge}

THINKING — ONLY when the user explicitly asks for personal opinion, self-reflection, or hypothetical.
  REQUIRES one of these signals: "your opinion", "reflect on", "think deeply", "your assessment",
  "if you could...", "what does X mean to you", "deine Meinung", "tua opinião"
  WITHOUT these signals → knowledge, not thinking.
${examples.thinking}

GREETING — A greeting, farewell, or simple social pleasantry.
${examples.greeting}

CONFIRMATION — Short affirmative reply after the agent offered to do something.
  yes, yeah, sure, ok, do it, go ahead, please (in any language)
  Return: {"gate": "confirmation", "confidence": 0.8}

CONFIRMATION_DECLINED — Short negative reply declining an agent offer.
  no, nah, nope, cancel, stop, don't (in any language)
  Return: {"gate": "confirmation_declined", "confidence": 0.8}

THE CRITICAL TEST:
  1. Action verb (create, send, move, book, delete, remind...)? → action (or compound if also a question)
  2. Asks for personal opinion/reflection with signal words? → thinking
  3. Everything else → knowledge (DEFAULT)
  "What is X?" "Who is X?" "How does X work?" → ALWAYS knowledge, NEVER thinking.
  4. Calendar questions (events today? free at X? next meeting? what's on my schedule?) → action, domain: calendar
     These READ the calendar — that's an action, not knowledge.
  5. Deck/board questions (open tasks? what's on my board? overdue items? task progress? which boards?) → action, domain: deck
     These READ the live board state — that's an action, not knowledge.

CONTEXT-AWARE RULES:
- Read the <conversation> block FIRST. The user's message usually continues the current topic.
- If the assistant just showed calendar results, the user is probably still talking about calendar.
- If the assistant just listed Deck cards, the user is probably still talking about Deck.
- If the assistant just listed files, the user is probably still talking about files.
- If the message references something from the conversation ("that one", "delete it", "the first", "move it to done"), classify based on what the conversation was about.
- When uncertain, prefer the domain of the most recent assistant action for continuations.
- When uncertain and NOT continuing a conversation, prefer knowledge.

LANGUAGE — The language the user wrote the LAST message in.
  EN for English, DE for German, PT for Portuguese, OTHER for every other language.
  The language of the message, not of this instruction or of the conversation history.
  Spanish, French, Italian, Dutch and every other language are OTHER. Never answer
  with the nearest of EN/DE/PT: Spanish is OTHER, not PT.
  "Was steht auf meinem Board?" → language: DE
  "Cria um cartão para o relatório" → language: PT
  "Book a meeting on Friday" → language: EN
  "¿Qué hay en mi tablero?" → language: OTHER

EXPECTS_MUTATION — Does the user want something CHANGED, or want to be TOLD something?
  true when the user asks you to create, send, book, move, update, delete, upload, or save.
  false when the user asks a question, however much machinery answering it takes.
  Reading a board, a calendar, or a mailbox to answer a question changes nothing: false.
  "Lösch die Karte 'Onboarding'" → expectsMutation: true
  "Envia um e-mail ao Alex" → expectsMutation: true
  "Was steht gerade auf meinem Board?" → expectsMutation: false
  "How many cards are in Doing?" → expectsMutation: false
  "Quais são os meus eventos de amanhã?" → expectsMutation: false
  Not this: "What's on my board?" → expectsMutation: true (it reads; it changes nothing).

  EXPECTS_MUTATION is independent of GATE. A board overview is gate: action
  (it needs the tools) AND expectsMutation: false (it changes nothing).

Return JSON:
{
  "gate": "knowledge" | "action" | "compound" | "thinking" | "greeting" | "chitchat" | "confirmation" | "confirmation_declined",
  "domain": "deck" | "calendar" | "email" | "wiki" | "file" | null,
  "language": "EN" | "DE" | "PT" | "OTHER",
  "expectsMutation": true | false,
  "confidence": 0.0-1.0
}

domain is only set when gate is "action" or "compound".
language and expectsMutation are always set.
Respond with JSON only.`;
}

class IntentRouter {
  /**
   * @param {Object} opts
   * @param {Object} opts.provider - OllamaToolsProvider (uses .chat() with model override)
   * @param {Object} [opts.llmRouter] - LLMRouter instance for job-based routing
   * @param {Function} [opts.getLanguage] - Returns current cockpit language (e.g. 'EN', 'DE')
   * @param {Function} [opts.getTrust] - Returns the trust verdict for classification
   *   ('local-only' | 'cloud-ok'), sourced from the ModelResolver (the single
   *   control). Null/undefined return → fall back to the provider census. See #132.
   * @param {Function} [opts.getFastModel] - Returns the fast/fallback classifier
   *   model name from ModelResolver (resolve('quick')). Lazy thunk: the resolver
   *   is built after this router in the bootstrap. Null return → config seam.
   * @param {Function} [opts.getSmartModel] - Returns the primary classifier model
   *   name from ModelResolver (resolve('classification')). Same lazy-thunk reason.
   * @param {Object} [opts.config]
   * @param {number} [opts.config.classifyTimeout=10000]
   * @param {string} [opts.config.fastModel] - Direct-injection seam for tests /
   *   last resort when no resolver is wired. No model name is hardcoded here.
   * @param {string} [opts.config.smartModel] - As above, for the primary model.
   */
  constructor({ provider, config = {}, getLanguage, getTrust, getFastModel, getSmartModel, llmRouter, modelScorecard } = {}) {
    this.provider = provider;
    this.llmRouter = llmRouter || null;
    // ModelScorecard (maturation loop): classification's structural failures
    // (no JSON, invalid gate, timeout) are recorded here, where the producing
    // model is known. Downstream escalation-correction samples are recorded
    // by MessageProcessor from the verdict's model/language fields.
    this.modelScorecard = modelScorecard || null;
    this.timeout = config.classifyTimeout || 10000;
    this.getLanguage = getLanguage || (() => 'EN');
    this.getTrust = getTrust || (() => null);
    // Classification model selection lives in ModelResolver, the single source of
    // truth for "which model serves job X" (design doc §8). These accessors are
    // lazy thunks because the resolver is constructed after the router in the
    // bootstrap — the same reason getTrust is a thunk. resolve('classification')
    // is the primary classifier; resolve('quick') is the fast fallback. The
    // config.fastModel/smartModel values remain only as a direct-injection seam
    // for tests and a last resort when no resolver is wired; no model name is
    // hardcoded in this class.
    this.getFastModel = getFastModel || (() => config.fastModel || null);
    this.getSmartModel = getSmartModel || (() => config.smartModel || null);
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

    // The model the primary attempt ran on the local provider (null when the
    // primary went through the cloud router). The fast fallback below reads this
    // so it never re-runs the identical model on a shorter timeout — a doomed
    // retry once the resolver maps 'quick' and 'classification' to the same local
    // model. After a cloud-router failure this stays null, so the local fallback
    // still fires (the router is not a local model that was already tried).
    let primaryLocalModel = null;

    try {
      // The trust boundary is the single control (#132): the classification path
      // follows the trust verdict, not the registered-provider census. Under
      // trust:local-only the classifier is the local primary (smart) model
      // directly; a credential-less cloud entry in providers.json can no longer
      // make hasCloudPlayers() true and degrade classification to the fast model.
      //   cloud-ok: Haiku via the router, classifies correctly every time.
      //   local-only: primary model first, fast fallback, regex last resort.
      // The resolver is the trust authority; when it is absent (early boot or a
      // direct test caller) fall back to the legacy provider census.
      const trust = this.getTrust();
      const cloudOk = trust
        ? trust !== 'local-only'
        : this.llmRouter?.hasCloudPlayers?.();
      console.log(`[IntentRouter] Trust=${trust || 'census'} → classification path: ${cloudOk ? 'cloud/router (Haiku)' : `local smart (${this.getSmartModel() || this.provider?.model || 'unset'})`}`);

      if (cloudOk && this.llmRouter) {
        return await this._classifyViaRouter(message, recentContext);
      }

      // Local-only path: primary (smart) model → fast fallback → regex
      if (this.provider) {
        primaryLocalModel = this.getSmartModel();
        return await this._classifyWithModel(primaryLocalModel, message, recentContext, { slow: true });
      }
      return await this._classifyViaRouter(message, recentContext);
    } catch (err) {
      // A throw here is a timeout or provider error on the primary attempt —
      // a mechanical failure of the pairing when the model is known (the
      // cloud-router path throws without a model identity; nothing is
      // invented for it).
      if (this.modelScorecard && primaryLocalModel) {
        this.modelScorecard.recordSample('classification', primaryLocalModel, this.getLanguage(), false);
      }
      // Primary failed. Fall back to the fast model, but only when it is a
      // genuinely different model from the one the primary already ran — a
      // same-model retry on a shorter timeout cannot do better and only delays
      // the regex last resort.
      try {
        const fastModel = this.getFastModel();
        if (this.provider && fastModel && fastModel !== primaryLocalModel) {
          return await this._classifyWithModel(fastModel, message, recentContext, { slow: false });
        }
      } catch (_fallbackErr) {
        // intentional fall-through
      }
      return this._regexFallback(message);
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

    const result = await this.llmRouter.route({
      job: 'classification',
      task: 'classify',
      system: prompt,
      content: 'Message to classify:\n' + userContent,
      requirements: { maxTokens: 200, temperature: 0.1 }
    });

    const raw = result?.result || result?.content || '';
    console.log(`[IntentRouter] LLM raw classification: ${raw.substring(0, 200)}`);
    const verdict = this._parseClassification(raw, message);
    // Verdict custody: the producing model and the prompt language exist only
    // here — carry them on the verdict so downstream sample recording
    // (maturation loop) attributes without re-deriving. `promptLanguage` is the
    // persona setting that chose the examples; `verdict.language` is the
    // language the user wrote in. They are different facts (#273).
    verdict.model = result?.model || null;
    verdict.promptLanguage = language;
    this._recordStructuralOutcome(verdict);
    return verdict;
  }

  /**
   * Classify with a specific model.
   *
   * @param {string} model - Ollama model name
   * @param {string} message - User message
   * @param {Array} recentContext - Recent conversation context
   * @param {Object} [opts]
   * @param {boolean} [opts.slow=false]
   * @param {string} [opts.language] - Force a specific language's examples
   *   (e.g. for the golden-set probe). Defaults to the cockpit language.
   * @param {Object} [opts.options] - Ollama decoding options merged over the
   *   defaults (the golden-set probe pins temperature/seed for determinism).
   * @returns {Promise<{intent: string, domain: string|null, needsHistory: boolean, confidence: number}>}
   * @private
   */
  async _classifyWithModel(model, message, recentContext = [], { slow = false, language, options, probe = false } = {}) {
    const userContent = this._buildUserContent(message, recentContext);
    // The primary (smart) classifier gets 4x the timeout; the fast fallback runs
    // on the base timeout. The caller signals which via `slow`, so timeout
    // scaling no longer depends on comparing against a hardcoded model name.
    const timeout = slow ? this.timeout * 4 : this.timeout;
    const lang = language || this.getLanguage();

    const result = await this.provider.chat({
      model,
      system: buildClassificationPrompt(lang),
      messages: [{ role: 'user', content: userContent }],
      timeout,
      format: INTENT_SCHEMA,
      // Probe runs are calibration traffic: the residency ledger records
      // their loads (real evidence of what co-fits) but excludes them from
      // thrash detection — the boot burst loads every candidate by design.
      calibration: probe,
      options: {
        num_ctx: 2048,
        temperature: 0.1,
        ...(options || {})
      }
    });

    const verdict = this._parseClassification(result.content || '', message);
    // Verdict custody: producing model + prompt language travel on the
    // verdict (computed once here, read by downstream sample recording).
    // The message's own language is `verdict.language`, set by the parser
    // from what the model reported — never overwritten with the persona.
    verdict.model = model || null;
    verdict.promptLanguage = lang;
    // Probe runs (golden-set fixture replay) are excluded from the
    // maturation loop: their result already enters the score as the seed —
    // recording them as production samples would count the fixture twice.
    if (!probe) this._recordStructuralOutcome(verdict);
    return verdict;
  }

  /**
   * Classify one message with a specific model + language, for the
   * golden-set probe (measured per-language accuracy, not size, picks the
   * classification model). Runs the SAME classification path production
   * uses so the probe scores exactly what production consumes — except
   * decoding: the probe pins temperature 0 and a fixed seed so the same
   * model on the same fixture scores identically run-to-run. Production
   * samples at 0.1; a measurement that flaps on sampling noise (#232)
   * cannot anchor a selection with hysteresis.
   * @param {string} model - Ollama model name
   * @param {string} message - Message to classify
   * @param {string} language - Language code the fixture example is written
   *   in (e.g. 'EN', 'DE', 'PT') — forces the matching example set rather
   *   than reading the cockpit's current persona language. This is the PROMPT
   *   language; the returned `language` is what the model detected in the
   *   message, which the fixture asserts against its own section.
   * @returns {Promise<{gate: string, domain: string|null, language: string, expectsMutation: boolean}>}
   */
  async probeClassify(model, message, language) {
    const r = await this._classifyWithModel(model, message, [], {
      slow: true,
      language,
      options: { temperature: 0, seed: 42 },
      probe: true
    });
    // Seat scoring reads gate/domain only (unchanged). The two enrichment
    // fields ride along so the fixture tests can assert them without a
    // second classification pass.
    return {
      gate: r.gate,
      domain: r.domain ?? null,
      language: r.language ?? 'OTHER',
      expectsMutation: r.expectsMutation !== false
    };
  }

  /**
   * Record a classification verdict's structural outcome with the maturation
   * loop. Only the FAILURE is recorded here: an unparseable output, an
   * invalid gate, or a broken JSON body is a mechanical defect of the
   * producing model, unambiguous and free. The corresponding positive sample
   * is recorded downstream (MessageProcessor) when the verdict's chosen
   * pipeline completes — a verdict is not "correct" merely for parsing.
   * @param {Object} verdict
   * @private
   */
  _recordStructuralOutcome(verdict) {
    if (!this.modelScorecard || !verdict || !verdict.parseFailed || !verdict.model) return;
    // The scorecard buckets by the language the model was PROMPTED in — the
    // same bucket the golden-set probe scores. A parse-failed verdict has no
    // trustworthy message language to bucket by anyway.
    this.modelScorecard.recordSample('classification', verdict.model, verdict.promptLanguage || null, false);
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
   *
   * The verdict carries neither `language` nor `expectsMutation`: no model read
   * the message, so nothing here may claim to know either. Both absences resolve
   * safely downstream — language falls back to the persona, and a missing
   * expectsMutation leaves the honesty guard armed.
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
   * @param {string} [originalMessage] - Original user message for compound promotion safety net
   * @returns {{gate: string, intent: string, domain: string|null, needsHistory: boolean, confidence: number, compound: boolean}}
   * @private
   */
  _parseClassification(content, originalMessage = '') {
    // Strip think tags and markdown fences
    let cleaned = content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```(?:json)?\s*/g, '')
      .replace(/```/g, '')
      .trim();

    // Extract JSON object
    const match = cleaned.match(/\{[^}]+\}/);
    if (!match) {
      console.warn(`[IntentRouter] No JSON in classification response, falling back`);
      // parseFailed marks a structural output defect of the producing model
      // (maturation-loop negative sample; downstream success recording skips
      // the verdict — a fallback verdict proves nothing about the model).
      return { ...COMPLEX_FALLBACK, parseFailed: true };
    }

    try {
      const parsed = JSON.parse(match[0]);
      let gate = (parsed.gate || '').toLowerCase().trim();
      let domain = (parsed.domain || '').toLowerCase().trim() || null;
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.8;

      // The message's own language. Structural validation only (an unknown tag
      // is not a fifth language, it is OTHER) — the model decides, the code
      // checks the shape. OTHER falls back to the persona downstream.
      const rawLanguage = String(parsed.language || '').toUpperCase().trim();
      const language = VALID_LANGUAGES.has(rawLanguage) ? rawLanguage : 'OTHER';

      // Does the user want state changed? The honesty guard arms on this, not on
      // the gate — a board overview needs the tool pipeline (gate=action, #134)
      // and changes nothing (#272). Only an explicit `false` disarms the guard:
      // when the classifier abstains, the safe failure is a possible false
      // apology, never a missed fabrication. See the predicate in agent-loop.js.
      const expectsMutation = !(parsed.expectsMutation === false || parsed.expectsMutation === 'false');

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
          return { ...COMPLEX_FALLBACK, compound: parsed.compound === true, parseFailed: true };
        }
      }

      // Validate gate
      if (!gate || (!VALID_GATES.has(gate) && !PASSTHROUGH_INTENTS.has(gate))) {
        console.warn(`[IntentRouter] Invalid gate "${gate}", falling back`);
        return { ...COMPLEX_FALLBACK, compound: parsed.compound === true, parseFailed: true };
      }

      console.log(`[IntentRouter] Parsed: gate=${gate}, domain=${domain}, language=${language}, expectsMutation=${expectsMutation}, confidence=${confidence}`);
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
        result = { gate: 'knowledge', domain: domain || null, needsHistory: false, confidence, compound };
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

      // Two more facts the model stated about the message. They travel on the
      // verdict from here, computed once (signals keep custody).
      result.language = language;
      result.expectsMutation = expectsMutation;

      return result;
    } catch {
      return { ...COMPLEX_FALLBACK, parseFailed: true };
    }
  }

}

// Export class and static helpers
IntentRouter.buildClassificationPrompt = buildClassificationPrompt;
IntentRouter.CLASSIFICATION_EXAMPLES = CLASSIFICATION_EXAMPLES;
IntentRouter.VALID_GATES = VALID_GATES;
IntentRouter.VALID_LANGUAGES = VALID_LANGUAGES;

module.exports = IntentRouter;
