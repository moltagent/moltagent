/**
 * MoltAgent Email Handler
 *
 * Architecture Brief:
 * -------------------
 * Problem: Users need to interact with email via natural language requests.
 * Email operations are diverse (read, search, draft, reply) and require
 * HITL confirmation before sending.
 *
 * Pattern: Intent-based handler with LLM parsing for flexible queries.
 * All send operations return requiresConfirmation flag.
 *
 * Key Dependencies:
 * - imap (IMAP client for reading emails)
 * - nodemailer (SMTP client for sending emails)
 * - mailparser (email parsing)
 * - src/lib/credential-broker.js (for IMAP/SMTP credentials)
 * - src/lib/llm-router.js (for intent parsing and drafting)
 * - src/lib/errors/error-handler.js (safe error handling)
 *
 * Data Flow:
 * - Message -> parseIntent() -> specific handler -> format response
 * - Draft/reply -> requiresConfirmation -> stored in MessageRouter
 * - Confirmation -> confirmSendEmail() -> send via SMTP
 *
 * Integration Points:
 * - Called by MessageRouter._handleEmail()
 * - confirmSendEmail() called by confirmation handlers
 *
 * @module handlers/email-handler
 * @version 1.0.0
 */

'use strict';

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const { createErrorHandler } = require('../errors/error-handler');
const appConfig = require('../config');
const { JOBS } = require('../llm/router');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} EmailIntent
 * @property {'check_inbox'|'check_unread'|'search_emails'|'read_email'|'summarize_emails'|'draft_email'|'draft_reply'} action
 * @property {string} [to] - Recipient email address
 * @property {string} [subject] - Email subject
 * @property {string} [body] - Email body content
 * @property {string} [from] - Sender to search for
 * @property {string} [query] - Search query
 * @property {string} [topic] - Topic to search or summarize
 * @property {number} [limit] - Number of emails to fetch
 * @property {string} [content] - Content for reply/email
 * @property {string} [tone] - Email tone (formal, casual, friendly)
 */

/**
 * @typedef {Object} ParsedEmail
 * @property {number} id - IMAP UID
 * @property {number} seqno - Sequence number
 * @property {string} messageId - RFC 2822 Message-ID
 * @property {string} from - From header (full)
 * @property {string} fromAddress - From email address only
 * @property {string} to - To header
 * @property {string} subject - Email subject
 * @property {Date} date - Email date
 * @property {string} snippet - Short text preview
 * @property {string} body - Full email body
 * @property {boolean} hasAttachments - Has attachments
 * @property {number} attachmentCount - Number of attachments
 * @property {boolean} isRead - Read status
 * @property {boolean} isStarred - Starred status
 */

/**
 * @typedef {Object} EmailDraft
 * @property {string} to - Recipient email address
 * @property {string} subject - Email subject
 * @property {string} body - Email body
 * @property {string} [inReplyTo] - Message-ID being replied to
 * @property {string} [references] - References header for threading
 */

/**
 * @typedef {Object} EmailHandlerResult
 * @property {boolean} success - True if operation succeeded
 * @property {string} message - User-facing response message
 * @property {boolean} [requiresConfirmation] - True if HITL confirmation needed
 * @property {string} [confirmationType] - Type of confirmation ('send_email')
 * @property {Object} [pendingAction] - Action data to execute after confirmation
 * @property {ParsedEmail[]} [emails] - Array of emails (for list operations)
 * @property {ParsedEmail} [email] - Single email (for read operations)
 * @property {EmailDraft} [draft] - Draft email data
 * @property {number} [emailCount] - Count of emails processed
 * @property {string} [messageId] - SMTP message ID (after send)
 */

/**
 * @typedef {Object} FetchEmailOptions
 * @property {string} [folder='INBOX'] - IMAP folder to fetch from
 * @property {number} [limit=10] - Maximum number of emails to fetch
 * @property {boolean} [unreadOnly=false] - Only fetch unread emails
 * @property {Array} [searchCriteria=null] - IMAP search criteria
 */

// -----------------------------------------------------------------------------
// Email Handler Class
// -----------------------------------------------------------------------------

class EmailHandler {
  /**
   * Create a new EmailHandler
   * @param {Object} credentialBroker - Credential broker for IMAP/SMTP credentials
   * @param {Object} llmRouter - LLM router for intent parsing and drafting
   * @param {Function} [auditLog] - Audit logging function
   */
  constructor(credentialBroker, llmRouter, auditLog) {
    this.credentials = credentialBroker;
    this.llm = llmRouter;
    this.auditLog = auditLog || (async () => {});

    // Connection state
    this._imapConnection = null;

    // Error handler for safe error messages
    this.errorHandler = createErrorHandler({
      serviceName: 'EmailHandler',
      auditLog: this.auditLog
    });
  }

  /**
   * Handle a natural language email request
   * @param {string} message - Natural language email request
   * @param {string} [user] - User making the request
   * @param {Object} [context={}] - Request context
   * @returns {Promise<EmailHandlerResult>} Result with response message
   */
  async handle(message, user, context = {}) {
    const intent = await this.parseIntent(message);

    console.log(`[Email] Intent: ${intent.action}`, JSON.stringify(intent).substring(0, 200));

    try {
      switch (intent.action) {
        case 'check_inbox':
          return await this.handleCheckInbox(intent, user);

        case 'check_unread':
          return await this.handleCheckUnread(intent, user);

        case 'search_emails':
          return await this.handleSearchEmails(intent, user);

        case 'read_email':
          return await this.handleReadEmail(intent, user, context);

        case 'summarize_emails':
          return await this.handleSummarizeEmails(intent, user);

        case 'draft_email':
          return await this.handleDraftEmail(intent, user, context);

        case 'draft_reply':
          return await this.handleDraftReply(intent, user, context);

        default:
          return {
            success: false,
            message: "I didn't understand that email request. Try:\n" +
                     "• 'Check my inbox'\n" +
                     "• 'Any unread emails?'\n" +
                     "• 'Search for emails from John'\n" +
                     "• 'Summarize emails about the project'\n" +
                     "• 'Draft an email to sarah@example.com'"
          };
      }
    } catch (error) {
      console.error('[Email] Error:', error);
      await this.auditLog('email_error', { action: intent.action, error: error.message });
      const { message } = await this.errorHandler.handle(error, {
        operation: intent.action,
        user
      });
      return {
        success: false,
        message
      };
    }
  }

  /**
   * Parse natural language into structured intent
   * @param {string} message - Natural language request
   * @returns {Promise<EmailIntent>} Structured intent object
   */
  async parseIntent(message) {
    const prompt = `Parse this email request into a structured action.

User request: "${message}"

Return JSON only (no markdown, no explanation):
{
  "action": "check_inbox|check_unread|search_emails|read_email|summarize_emails|draft_email|draft_reply",
  "to": "recipient email if sending",
  "subject": "subject if mentioned",
  "body": "body content if provided",
  "from": "sender to search for",
  "query": "search query",
  "topic": "topic to search or summarize",
  "limit": "number of emails if mentioned",
  "content": "what to say in reply/email",
  "tone": "formal|casual|friendly if mentioned"
}

Only include relevant fields.

Examples:
- "check my inbox" → {"action": "check_inbox"}
- "any unread emails?" → {"action": "check_unread"}
- "find emails from John" → {"action": "search_emails", "from": "John"}
- "summarize emails about the project" → {"action": "summarize_emails", "topic": "project"}
- "draft an email to john@example.com about the meeting" → {"action": "draft_email", "to": "john@example.com", "topic": "meeting"}
- "reply to that saying I agree" → {"action": "draft_reply", "content": "agreement"}`;

    try {
      const response = await this.llm.route({
        job: JOBS.TOOLS,
        task: 'email_parse',
        content: prompt,
        requirements: { role: 'free' }
      });

      let cleaned = response.response || response;
      if (typeof cleaned === 'object' && cleaned.response) {
        cleaned = cleaned.response;
      }

      cleaned = String(cleaned)
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();

      return JSON.parse(cleaned);
    } catch (e) {
      console.error('[Email] Intent parse failed:', e.message);
      return this.fallbackIntentParse(message);
    }
  }

  /**
   * Simple fallback intent parsing
   * @param {string} message - Natural language request
   * @returns {EmailIntent} Structured intent object
   */
  fallbackIntentParse(message) {
    const lower = message.toLowerCase();

    // Check for send/draft FIRST (higher priority than generic "mail")
    if (lower.includes('send') || lower.includes('draft') || lower.includes('write') || lower.includes('compose')) {
      // Try to extract email address
      const emailMatch = message.match(/[\w.-]+@[\w.-]+\.\w+/);

      // Try to extract subject (between quotes after "subject")
      const subjectMatch = message.match(/subject[:\s]+["']([^"']+)["']/i) ||
                          message.match(/subject[:\s]+([^"'\n,]+)/i);

      // Try to extract body (between quotes after "body" or "saying" or "with message")
      const bodyMatch = message.match(/(?:body|saying|message)[:\s]+["']([^"']+)["']/i) ||
                       message.match(/(?:body|saying|message)[:\s]+(.+?)(?:\.|$)/i);

      return {
        action: 'draft_email',
        to: emailMatch ? emailMatch[0] : undefined,
        subject: subjectMatch ? subjectMatch[1].trim() : undefined,
        body: bodyMatch ? bodyMatch[1].trim() : undefined
      };
    }
    if (lower.includes('reply')) {
      return { action: 'draft_reply' };
    }
    if (lower.includes('unread')) {
      return { action: 'check_unread' };
    }
    if (lower.includes('search') || lower.includes('find')) {
      return { action: 'search_emails' };
    }
    if (lower.includes('summarize') || lower.includes('summary')) {
      return { action: 'summarize_emails' };
    }
    if (lower.includes('inbox') || lower.includes('check')) {
      return { action: 'check_inbox' };
    }

    // Default: if "mail" or "email" is mentioned, check inbox
    return { action: 'check_inbox' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IMAP Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get IMAP credentials from NC Passwords
   * @returns {Promise<Object>} IMAP credential object
   * @private
   */
  async _getImapCredentials() {
    const cred = await this.credentials.get('email-imap');
    if (!cred) {
      throw new Error("Email not configured. Please add 'email-imap' credential to NC Passwords.");
    }
    return cred;
  }

  /**
   * Fetch emails from IMAP
   * @param {FetchEmailOptions} [options={}] - Fetch options
   * @returns {Promise<ParsedEmail[]>} Array of parsed emails
   * @private
   */
  async _fetchEmails(options = {}) {
    const {
      folder = 'INBOX',
      limit = 10,
      unreadOnly = false,
      searchCriteria = null
    } = options;

    const cred = await this._getImapCredentials();

    return new Promise((resolve, reject) => {
      // Support both TLS (port 993) and STARTTLS (port 143)
      const port = parseInt(cred.port) || appConfig.ports.imapDefault;
      const useDirectTls = cred.tls === true || cred.tls === 'true' || (port === appConfig.ports.imapDefault && cred.tls !== false && cred.tls !== 'false');
      const useStartTls = cred.starttls === true || cred.starttls === 'true' || port === appConfig.ports.imapStarttls;

      const imap = new Imap({
        user: cred.username || cred.user,
        password: cred.password,
        host: cred.host,
        port: port,
        tls: useDirectTls && !useStartTls,
        autotls: useStartTls ? 'required' : 'never',
        tlsOptions: {
          rejectUnauthorized: cred.tlsSkipVerify !== true && cred.tlsSkipVerify !== 'true'
        },
        connTimeout: appConfig.timeouts.imapConnection
      });

      const emails = [];

      imap.once('ready', () => {
        imap.openBox(folder, true, (err, box) => {
          if (err) {
            imap.end();
            return reject(err);
          }

          // Build search criteria
          let criteria = unreadOnly ? ['UNSEEN'] : ['ALL'];
          if (searchCriteria) {
            criteria = searchCriteria;
          }

          imap.search(criteria, (err, results) => {
            if (err) {
              imap.end();
              return reject(err);
            }

            if (results.length === 0) {
              imap.end();
              return resolve([]);
            }

            // Get latest emails (up to limit)
            const toFetch = results.slice(-limit);

            const fetch = imap.fetch(toFetch, {
              bodies: '',
              struct: true
            });

            fetch.on('message', (msg, seqno) => {
              let buffer = '';
              let attrs = null;

              msg.on('body', (stream) => {
                stream.on('data', (chunk) => {
                  buffer += chunk.toString('utf8');
                });
              });

              msg.once('attributes', (a) => {
                attrs = a;
              });

              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(buffer);
                  emails.push({
                    id: attrs.uid,
                    seqno,
                    messageId: parsed.messageId,
                    from: parsed.from?.text || '',
                    fromAddress: parsed.from?.value?.[0]?.address || '',
                    to: parsed.to?.text || '',
                    subject: parsed.subject || '(No subject)',
                    date: parsed.date,
                    snippet: this._getSnippet(parsed.text, 200),
                    body: parsed.text || '',
                    hasAttachments: (parsed.attachments?.length || 0) > 0,
                    attachmentCount: parsed.attachments?.length || 0,
                    isRead: attrs.flags.includes('\\Seen'),
                    isStarred: attrs.flags.includes('\\Flagged')
                  });
                } catch (e) {
                  console.error('[Email] Parse error:', e.message);
                }
              });
            });

            fetch.once('end', () => {
              imap.end();
              // Sort by date descending
              emails.sort((a, b) => new Date(b.date) - new Date(a.date));
              resolve(emails);
            });

            fetch.once('error', (err) => {
              imap.end();
              reject(err);
            });
          });
        });
      });

      imap.once('error', (err) => {
        reject(err);
      });

      imap.connect();
    });
  }

  /**
   * Extract a text snippet with maximum length
   * @param {string} text - Full text content
   * @param {number} maxLength - Maximum snippet length
   * @returns {string} Truncated snippet
   * @private
   */
  _getSnippet(text, maxLength) {
    if (!text) return '';
    const cleaned = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (cleaned.length <= maxLength) return cleaned;
    return cleaned.slice(0, maxLength).trim() + '...';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query Handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handle inbox check request
   * @param {EmailIntent} intent - Parsed intent
   * @param {string} user - User making the request
   * @returns {Promise<EmailHandlerResult>} Response with email list
   */
  async handleCheckInbox(intent, user) {
    const emails = await this._fetchEmails({
      limit: intent.limit || 10,
      unreadOnly: false
    });

    await this.auditLog('email_inbox_checked', { user, count: emails.length });

    const unreadCount = emails.filter(e => !e.isRead).length;

    if (emails.length === 0) {
      return {
        success: true,
        message: "📭 The mailbox is empty!"
      };
    }

    return {
      success: true,
      message: this._formatEmailList(emails, unreadCount),
      emails: emails.map(e => ({ id: e.id, subject: e.subject, from: e.from }))
    };
  }

  /**
   * Handle unread emails check request
   * @param {EmailIntent} intent - Parsed intent
   * @param {string} user - User making the request
   * @returns {Promise<EmailHandlerResult>} Response with unread email list
   */
  async handleCheckUnread(intent, user) {
    const emails = await this._fetchEmails({
      limit: 20,
      unreadOnly: true
    });

    await this.auditLog('email_unread_checked', { user, count: emails.length });

    if (emails.length === 0) {
      return {
        success: true,
        message: "✅ No unread emails! You're all caught up."
      };
    }

    return {
      success: true,
      message: this._formatEmailList(emails, emails.length, true),
      emails: emails.map(e => ({ id: e.id, subject: e.subject, from: e.from }))
    };
  }

  /**
   * Handle email search request
   * @param {EmailIntent} intent - Parsed intent with search criteria
   * @param {string} user - User making the request
   * @returns {Promise<EmailHandlerResult>} Response with search results
   */
  async handleSearchEmails(intent, user) {
    let searchCriteria = ['ALL'];

    if (intent.from) {
      searchCriteria = [['FROM', intent.from]];
    } else if (intent.subject) {
      searchCriteria = [['SUBJECT', intent.subject]];
    } else if (intent.query) {
      // Search in subject (IMAP limitation - can't search body easily)
      searchCriteria = [['SUBJECT', intent.query]];
    } else {
      return {
        success: false,
        message: "What would you like to search for? Try 'search for emails from John' or 'find emails about project'."
      };
    }

    const emails = await this._fetchEmails({
      limit: intent.limit || 20,
      searchCriteria
    });

    await this.auditLog('email_search', { user, criteria: intent.from || intent.subject || intent.query, count: emails.length });

    if (emails.length === 0) {
      return {
        success: true,
        message: "🔍 No emails found matching your search."
      };
    }

    return {
      success: true,
      message: this._formatEmailList(emails, 0, false, 'Search results'),
      emails: emails.map(e => ({ id: e.id, subject: e.subject, from: e.from }))
    };
  }

  /**
   * Handle read email request
   * @param {EmailIntent} intent - Parsed intent
   * @param {string} user - User making the request
   * @param {Object} context - Request context (stores lastEmail)
   * @returns {Promise<EmailHandlerResult>} Response with full email content
   */
  async handleReadEmail(intent, user, context) {
    // For now, show the first unread or most recent
    const emails = await this._fetchEmails({ limit: 5, unreadOnly: true });

    if (emails.length === 0) {
      return {
        success: true,
        message: "No unread emails to show."
      };
    }

    const email = emails[0];

    await this.auditLog('email_read', { user, from: email.fromAddress, subject: email.subject });

    // Store in context for potential reply
    context.lastEmail = email;

    return {
      success: true,
      message: this._formatFullEmail(email),
      email: { id: email.id, subject: email.subject, from: email.from }
    };
  }

  /**
   * Handle email summarization request
   * @param {EmailIntent} intent - Parsed intent with topic/from filters
   * @param {string} user - User making the request
   * @returns {Promise<EmailHandlerResult>} Response with LLM summary
   */
  async handleSummarizeEmails(intent, user) {
    let searchCriteria = ['ALL'];
    let description = 'recent emails';

    if (intent.from) {
      searchCriteria = [['FROM', intent.from]];
      description = `emails from ${intent.from}`;
    } else if (intent.topic) {
      searchCriteria = [['SUBJECT', intent.topic]];
      description = `emails about "${intent.topic}"`;
    }

    const emails = await this._fetchEmails({
      limit: 20,
      searchCriteria
    });

    if (emails.length === 0) {
      return {
        success: true,
        message: `No ${description} found to summarize.`
      };
    }

    // Use LLM to summarize
    const emailSummaries = emails.slice(0, 15).map(e =>
      `From: ${e.from}\nSubject: ${e.subject}\nDate: ${this._formatDate(e.date)}\nSnippet: ${e.snippet}`
    ).join('\n\n---\n\n');

    const summaryPrompt = `Summarize these ${description}:

${emailSummaries}

Provide a concise summary organized by topic or sender. Highlight:
- Key action items
- Important deadlines
- Urgent matters
- Decisions needed

Format nicely with bullet points and bold for emphasis. Keep it brief.`;

    const response = await this.llm.route({
      job: JOBS.QUICK,
      task: 'email_summarize',
      content: summaryPrompt,
      requirements: { role: 'free' }
    });

    await this.auditLog('email_summarized', { user, count: emails.length, topic: intent.topic || intent.from });

    let summary = response.response || response;
    if (typeof summary === 'object' && summary.response) {
      summary = summary.response;
    }

    // Clean up any thinking tags
    summary = String(summary).replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    return {
      success: true,
      message: `📧 **Summary of ${emails.length} ${description}:**\n\n${summary}`,
      emailCount: emails.length
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Draft & Send Handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handle draft email request (requires HITL confirmation)
   * @param {EmailIntent} intent - Parsed intent with to/subject/body
   * @param {string} user - User making the request
   * @param {Object} context - Request context
   * @returns {Promise<EmailHandlerResult>} Response with draft preview and requiresConfirmation=true
   */
  async handleDraftEmail(intent, user, context) {
    if (!intent.to) {
      return {
        success: false,
        message: "Who should I send this to? Please provide an email address."
      };
    }

    // Generate email body using LLM if we have enough context
    let body = intent.body || '';

    if (!body && (intent.topic || intent.content)) {
      const draftPrompt = `Draft a professional email:

To: ${intent.to}
Subject: ${intent.subject || intent.topic || 'Message'}
Topic/Key points: ${intent.content || intent.topic || 'general message'}
Tone: ${intent.tone || 'professional'}

Write only the email body (greeting through sign-off). Keep it concise.`;

      const response = await this.llm.route({
        job: JOBS.WRITING,
        task: 'email_draft',
        content: draftPrompt,
        requirements: { role: 'free' }
      });

      body = response.response || response;
      if (typeof body === 'object' && body.response) {
        body = body.response;
      }
      body = String(body).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }

    const draft = {
      to: intent.to,
      subject: intent.subject || intent.topic || 'Message',
      body: body || '(Please provide email content)'
    };

    const preview = this._formatDraftPreview(draft);

    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'send_email',
      pendingAction: {
        action: 'send_email',
        data: draft
      },
      message: `📝 Here's your draft:\n\n${preview}\n\nReply **yes** to send, **edit** to modify, or **no** to cancel.`,
      draft
    };
  }

  /**
   * Handle draft reply request (requires HITL confirmation)
   * @param {EmailIntent} intent - Parsed intent with reply content
   * @param {string} user - User making the request
   * @param {Object} context - Request context (uses lastEmail)
   * @returns {Promise<EmailHandlerResult>} Response with draft preview and requiresConfirmation=true
   */
  async handleDraftReply(intent, user, context) {
    // Get the email to reply to
    if (!context.lastEmail) {
      // Fetch the most recent unread email
      const emails = await this._fetchEmails({ limit: 1, unreadOnly: true });
      if (emails.length === 0) {
        const allEmails = await this._fetchEmails({ limit: 1 });
        if (allEmails.length === 0) {
          return {
            success: false,
            message: "No emails to reply to. Please specify which email you want to reply to."
          };
        }
        context.lastEmail = allEmails[0];
      } else {
        context.lastEmail = emails[0];
      }
    }

    const original = context.lastEmail;

    // Generate reply using LLM
    const replyPrompt = `Draft a reply to this email:

From: ${original.from}
Subject: ${original.subject}
Original message: ${original.snippet}

User wants to: ${intent.content || intent.response || 'reply appropriately'}
Tone: ${intent.tone || 'professional'}

Write only the reply body. Be concise and appropriate.`;

    const response = await this.llm.route({
      job: JOBS.WRITING,
      task: 'email_reply',
      content: replyPrompt,
      requirements: { role: 'free' }
    });

    let replyBody = response.response || response;
    if (typeof replyBody === 'object' && replyBody.response) {
      replyBody = replyBody.response;
    }
    replyBody = String(replyBody).replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    const draft = {
      to: original.fromAddress,
      subject: original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`,
      body: replyBody,
      inReplyTo: original.messageId
    };

    const preview = this._formatDraftPreview(draft);

    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'send_email',
      pendingAction: {
        action: 'send_email',
        data: draft
      },
      message: `📝 Here's your reply draft:\n\n${preview}\n\nReply **yes** to send, **edit** to modify, or **no** to cancel.`,
      draft
    };
  }

  /**
   * Execute confirmed email send
   * IMPORTANT: This should ONLY be called after HITL approval
   * @param {EmailDraft} draft - Draft email to send
   * @param {string} user - User who approved the send
   * @returns {Promise<EmailHandlerResult>} Response with send confirmation
   */
  async confirmSendEmail(draft, user) {
    // Get SMTP credentials
    const cred = await this.credentials.get('email-smtp');
    if (!cred) {
      throw new Error("Email sending not configured. Please add 'email-smtp' credential to NC Passwords.");
    }

    // Get email footer (custom or default)
    const footer = await this._getEmailFooter(user);

    const port = parseInt(cred.port) || appConfig.ports.smtpDefault;
    const transporter = nodemailer.createTransport({
      host: cred.host,
      port: port,
      secure: port === appConfig.ports.smtpTls,  // true for 465 (SSL), false for 587 (STARTTLS)
      auth: {
        user: cred.username || cred.user,
        pass: cred.password
      },
      connectionTimeout: appConfig.timeouts.smtpConnection
    });

    // Append footer to body
    const bodyWithFooter = footer ? `${draft.body}\n\n${footer}` : draft.body;

    const mailOptions = {
      from: cred.from || cred.username || cred.user,
      to: draft.to,
      subject: draft.subject,
      text: bodyWithFooter,
      inReplyTo: draft.inReplyTo
    };

    const result = await transporter.sendMail(mailOptions);

    await this.auditLog('email_sent', {
      user,
      to: draft.to,
      subject: draft.subject,
      messageId: result.messageId
    });

    return {
      success: true,
      message: `✅ Email sent to ${draft.to}!`,
      messageId: result.messageId
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Email Footer
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get email footer - custom from NC Passwords or default
   * @param {string} user - The NC username sending the email
   * @returns {string|null} Footer text or null if disabled
   */
  async _getEmailFooter(user) {
    // Try to get custom footer from NC Passwords
    try {
      const customFooter = await this.credentials.get('email-footer');

      // If it's a string (simple credential), use it directly
      if (typeof customFooter === 'string') {
        // Check for disable marker
        if (customFooter === '---NONE---' || customFooter.trim() === '') {
          return null;
        }
        // Replace [USER] placeholder with actual username
        return customFooter.replace(/\[USER\]/gi, user || 'User');
      }

      // If it's an object (complex credential), use password field
      if (customFooter && customFooter.password) {
        if (customFooter.password === '---NONE---' || customFooter.password.trim() === '') {
          return null;
        }
        return customFooter.password.replace(/\[USER\]/gi, user || 'User');
      }
    } catch (error) {
      // No custom footer configured, use default
      // Only log if it's not a "not found" error (which is expected)
      if (!error.message?.includes('not found')) {
        console.debug('[EmailHandler] Could not load custom footer:', error.message);
      }
    }

    // Default footer with AI disclosure
    const defaultFooter = `--
🤖 Sent via Moltagent AI Assistant on behalf of ${user || 'User'}
Learn more: https://moltagent.cloud`;

    return defaultFooter;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Formatting Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Format email list for display
   * @param {ParsedEmail[]} emails - Array of emails to format
   * @param {number} unreadCount - Count of unread emails
   * @param {boolean} [showUnreadOnly=false] - Whether list is unread only
   * @param {string} [title=null] - Optional custom title
   * @returns {string} Formatted email list
   * @private
   */
  _formatEmailList(emails, unreadCount, showUnreadOnly = false, title = null) {
    const header = title
      ? `📬 **${title}** (${emails.length} emails):\n\n`
      : `📬 **Inbox** (${unreadCount} unread):\n\n`;

    const lines = [header];

    for (let i = 0; i < Math.min(emails.length, 10); i++) {
      const e = emails[i];
      const unreadMarker = e.isRead ? '' : '🔴 ';
      const attachMarker = e.hasAttachments ? '📎 ' : '';
      const timeAgo = this._formatTimeAgo(e.date);
      const fromName = e.from.split('<')[0].trim() || e.fromAddress;

      lines.push(`${unreadMarker}${attachMarker}**${fromName}** (${timeAgo})`);
      lines.push(`"${e.subject}"`);
      lines.push('');
    }

    if (emails.length > 10) {
      lines.push(`\n...and ${emails.length - 10} more emails.`);
    }

    lines.push('\nWould you like me to read or summarize any of these?');

    return lines.join('\n');
  }

  /**
   * Format full email for display
   * @param {ParsedEmail} email - Email to format
   * @returns {string} Formatted email content
   * @private
   */
  _formatFullEmail(email) {
    return `📧 **${email.subject}**

**From:** ${email.from}
**Date:** ${this._formatDate(email.date)}
${email.hasAttachments ? `**Attachments:** ${email.attachmentCount} file(s)\n` : ''}───────────────────

${email.body.slice(0, 1500)}${email.body.length > 1500 ? '\n\n...(truncated)' : ''}

───────────────────
Would you like to reply, forward, or archive this email?`;
  }

  /**
   * Format draft email preview
   * @param {EmailDraft} draft - Draft to format
   * @returns {string} Formatted draft preview
   * @private
   */
  _formatDraftPreview(draft) {
    return `───────────────────
**To:** ${draft.to}
**Subject:** ${draft.subject}

${draft.body}
───────────────────`;
  }

  /**
   * Format date for display
   * @param {Date} date - Date to format
   * @returns {string} Formatted date string
   * @private
   */
  _formatDate(date) {
    if (!date) return '';
    const d = new Date(date);
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  /**
   * Format date as relative time (e.g., "2h ago")
   * @param {Date} date - Date to format
   * @returns {string} Relative time string
   * @private
   */
  _formatTimeAgo(date) {
    if (!date) return '';
    const now = new Date();
    const d = new Date(date);
    const diff = now - d;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

module.exports = EmailHandler;
