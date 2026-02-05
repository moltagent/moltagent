/**
 * Moltagent Email Monitor Service
 *
 * Periodically checks Moltagent's inbox for new emails,
 * analyzes them using LLM, and notifies humans via NC Talk.
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const appConfig = require('../config');
const { pendingEmailReplies } = require('../pending-action-store');
const ContentProvenance = require('../../security/content-provenance');
const { JOBS } = require('../llm/router');

class EmailMonitor {
  constructor(options = {}) {
    this.credentials = options.credentialBroker;
    this.llm = options.llmRouter;
    this.calendar = options.calendarClient; // CalDAV client for meeting awareness
    this.auditLog = options.auditLog || (async () => {});
    this.sendTalkMessage = options.sendTalkMessage; // Function to send NC Talk messages
    this.defaultToken = options.defaultToken; // Default NC Talk room token

    // Heartbeat interval
    this.heartbeatInterval = options.heartbeatInterval || appConfig.heartbeat.intervalMs;

    // Storage for processed email IDs
    this.processedEmailsFile = options.processedEmailsFile || '/opt/moltagent/data/processed-emails.json';
    this.processedEmails = this._loadProcessedEmails();

    // State
    this._heartbeatTimer = null;
    this._isRunning = false;
    this._isChecking = false;

    // Pending notifications (emails analyzed but couldn't notify due to missing room)
    this._pendingNotifications = [];

    // Configuration (can be updated via natural language)
    this.config = {
      notifyRoom: options.defaultToken, // NC Talk room token for notifications
      notifyUser: null // Specific user to notify (null = room)
    };

    console.log(`[EmailMonitor] Calendar integration: ${this.calendar ? 'enabled' : 'disabled'}`);
  }

  /**
   * Start the email monitor heartbeat
   */
  start() {
    if (this._isRunning) {
      console.log('[EmailMonitor] Already running');
      return;
    }

    console.log(`[EmailMonitor] Starting with ${this.heartbeatInterval / 1000}s interval`);
    this._isRunning = true;

    // Initial check after delay (let system stabilize)
    setTimeout(() => this.checkInbox(), appConfig.emailMonitor.initialDelayMs);

    // Regular heartbeat
    this._heartbeatTimer = setInterval(() => {
      this.checkInbox();
    }, this.heartbeatInterval);
  }

  /**
   * Check if monitor is available (not currently checking)
   */
  isAvailable() {
    return !this._isChecking;
  }

  /**
   * Stop the email monitor
   */
  stop() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._isRunning = false;
    console.log('[EmailMonitor] Stopped');
  }

  /**
   * Check inbox for new emails
   */
  async checkInbox() {
    if (this._isChecking) {
      console.log('[EmailMonitor] Already checking, skipping');
      return { checked: false, found: 0, processed: 0 };
    }

    this._isChecking = true;
    console.log('[EmailMonitor] Checking inbox...');
    let processed = 0;

    try {
      const emails = await this._fetchUnreadEmails();

      if (emails.length === 0) {
        console.log('[EmailMonitor] No new emails');
        this._isChecking = false;
        return { checked: true, found: 0, processed: 0 };
      }

      console.log(`[EmailMonitor] Found ${emails.length} unread email(s)`);

      for (const email of emails) {
        // Skip if already processed
        if (this._isProcessed(email.messageId)) {
          console.log(`[EmailMonitor] Skipping already processed: ${email.messageId}`);
          continue;
        }

        await this._processEmail(email);
        this._markProcessed(email.messageId);
        processed++;
      }

      return { checked: true, found: emails.length, processed };

    } catch (error) {
      console.error('[EmailMonitor] Error checking inbox:', error.message);
      await this.auditLog('email_monitor_error', { error: error.message });
      throw error;
    } finally {
      this._isChecking = false;
    }
  }

  /**
   * Fetch unread emails from IMAP
   */
  async _fetchUnreadEmails() {
    const cred = await this.credentials.get('email-imap');
    if (!cred) {
      throw new Error('email-imap credential not configured');
    }

    return new Promise((resolve, reject) => {
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
        imap.openBox('INBOX', false, (err, box) => { // false = read-write
          if (err) {
            imap.end();
            return reject(err);
          }

          // Debug: log box info
          console.log(`[EmailMonitor] Mailbox: ${box.messages.total} total, ${box.messages.new} new`);

          imap.search(['UNSEEN'], (err, results) => {
            if (err) {
              console.error('[EmailMonitor] Search error:', err);
              imap.end();
              return reject(err);
            }

            console.log(`[EmailMonitor] UNSEEN search: ${results ? results.length : 0} results`);

            if (!results || results.length === 0) {
              imap.end();
              return resolve([]);
            }

            console.log(`[EmailMonitor] Fetching ${results.length} messages: ${results.join(', ')}`);
            const fetch = imap.fetch(results, { bodies: '', markSeen: false });
            const parsePromises = [];

            fetch.on('message', (msg, seqno) => {
              console.log(`[EmailMonitor] Processing message seqno: ${seqno}`);

              // Create a promise for each message that resolves when parsing is done
              const parsePromise = new Promise((resolveMsg) => {
                msg.on('body', (stream) => {
                  let buffer = '';
                  stream.on('data', chunk => buffer += chunk.toString('utf8'));
                  stream.once('end', async () => {
                    console.log(`[EmailMonitor] Parsing message, buffer size: ${buffer.length}`);
                    try {
                      const parsed = await simpleParser(buffer);
                      console.log(`[EmailMonitor] Parsed: from=${parsed.from?.text}, subject=${parsed.subject}`);
                      const emailData = {
                        seqno,
                        messageId: parsed.messageId || `unknown-${Date.now()}-${seqno}`,
                        from: parsed.from?.text || 'Unknown',
                        fromAddress: parsed.from?.value?.[0]?.address || '',
                        to: parsed.to?.text || '',
                        cc: parsed.cc?.text || '',
                        subject: parsed.subject || '(No Subject)',
                        date: parsed.date,
                        text: parsed.text || '',
                        html: parsed.html || '',
                        inReplyTo: parsed.inReplyTo,
                        references: parsed.references
                      };
                      emails.push(emailData);
                      console.log(`[EmailMonitor] Added email to list, count: ${emails.length}`);
                    } catch (parseErr) {
                      console.error('[EmailMonitor] Parse error:', parseErr.message);
                    }
                    resolveMsg();
                  });
                });
              });
              parsePromises.push(parsePromise);
            });

            fetch.once('end', async () => {
              // Wait for all parsing to complete
              await Promise.all(parsePromises);
              console.log(`[EmailMonitor] Fetch complete, resolving with ${emails.length} emails`);
              imap.end();
              resolve(emails);
            });

            fetch.once('error', (err) => {
              imap.end();
              reject(err);
            });
          });
        });
      });

      imap.once('error', reject);
      imap.connect();
    });
  }

  /**
   * Process a single email - analyze and notify
   */
  async _processEmail(email) {
    console.log(`[EmailMonitor] Processing: "${email.subject}" from ${email.from}`);

    await this.auditLog('email_received', {
      messageId: email.messageId,
      from: email.from,
      subject: email.subject
    });

    // Analyze email with LLM
    const analysis = await this._analyzeEmail(email);

    console.log(`[EmailMonitor] Analysis: needs_response=${analysis.needs_response}, urgency=${analysis.urgency}, is_meeting=${analysis.is_meeting_request || false}`);

    // If it's a meeting request and we have calendar access, check availability
    if (analysis.is_meeting_request && analysis.meeting_details?.proposed_datetime && this.calendar) {
      try {
        const calendarContext = await this._checkMeetingAvailability(analysis.meeting_details);
        analysis.calendar_context = calendarContext;
        console.log(`[EmailMonitor] Calendar check: available=${calendarContext.is_available}`);
      } catch (err) {
        console.error(`[EmailMonitor] Calendar check failed: ${err.message}`);
        analysis.calendar_context = { error: err.message };
      }
    }

    // Build notification message
    const notification = this._buildNotification(email, analysis);

    // Send to NC Talk
    if (this.sendTalkMessage && this.config.notifyRoom) {
      try {
        await this.sendTalkMessage(this.config.notifyRoom, notification);
        await this.auditLog('email_notification_sent', {
          messageId: email.messageId,
          room: this.config.notifyRoom,
          needsResponse: analysis.needs_response
        });

        // If needs response, store pending action for HITL
        if (analysis.needs_response && analysis.draft_response) {
          this._storePendingReply(email, analysis);
        }

        // Mark email as seen in IMAP
        await this._markEmailSeen(email.seqno);

      } catch (err) {
        console.error('[EmailMonitor] Failed to send notification:', err.message);
      }
    } else if (!this.config.notifyRoom) {
      // No room token yet - store notification for later
      console.log(`[EmailMonitor] No notification room configured, queuing notification for: ${email.messageId}`);
      this._pendingNotifications.push({
        email,
        analysis,
        notification,
        timestamp: Date.now()
      });
      // Keep only last 10 pending notifications to prevent memory issues
      if (this._pendingNotifications.length > 10) {
        this._pendingNotifications.shift();
      }
    }
  }

  /**
   * Analyze email using LLM
   */
  async _analyzeEmail(email) {
    // Frame email body as EXTERNAL content (Spec B - prompt injection protection)
    const framedBody = ContentProvenance.frameExternalContent(
      email.text?.substring(0, 2000) || '(empty)',
      { tool: 'mail_read', from: email.from, subject: email.subject }
    );

    const prompt = `Analyze this email received by an AI assistant (Moltagent) and respond with JSON only.

Determine:
1. Does this email need a response from Moltagent?
   - Direct questions or requests → YES
   - CC/BCC informational emails → Usually NO
   - Newsletters, notifications, automated emails → NO
2. If yes, what urgency? (high/medium/low)
3. Is this a MEETING REQUEST? Look for:
   - Requests to meet, schedule a call, have a discussion
   - Proposed dates/times like "tomorrow at 2pm", "next Tuesday", "Feb 10th"
   - Phrases like "are you free", "can we meet", "let's schedule"
4. If meeting request, extract the proposed date/time
5. Provide a brief summary
6. If needs response, draft a helpful reply

Email:
From: ${email.from}
To: ${email.to}
CC: ${email.cc || 'none'}
Subject: ${email.subject}
Date: ${email.date}
Body:
${framedBody}

Today's date is: ${new Date().toISOString().split('T')[0]}

Respond with JSON only:
{
  "needs_response": true/false,
  "urgency": "high/medium/low/none",
  "reason": "brief explanation",
  "summary": "1-2 sentence summary of the email",
  "is_meeting_request": true/false,
  "meeting_details": {
    "proposed_datetime": "ISO datetime string if mentioned, e.g. 2026-02-05T14:00:00, or null",
    "duration_minutes": 60,
    "topic": "what the meeting is about",
    "location": "if mentioned, otherwise null"
  },
  "draft_response": "suggested reply if needs_response is true, otherwise null"
}`;

    try {
      const result = await this.llm.route({
        job: JOBS.TOOLS,
        task: 'email_analyze',
        content: prompt,
        requirements: { role: 'free' },
        context: { trigger: 'heartbeat_email' }
      });

      let response = result.result || result.response || result;
      if (typeof response === 'object' && response.result) {
        response = response.result;
      }

      // Clean up response - remove thinking tags and markdown
      response = String(response)
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      // Find JSON in response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      throw new Error('No JSON found in response');

    } catch (error) {
      console.error('[EmailMonitor] Analysis error:', error.message);

      // Fallback: assume needs response if sent directly to Moltagent
      const isDirectlyAddressed = email.to?.toLowerCase().includes('moltagent');
      return {
        needs_response: isDirectlyAddressed,
        urgency: isDirectlyAddressed ? 'medium' : 'low',
        reason: 'Analysis failed, using fallback',
        summary: `Email from ${email.from}: ${email.subject}`,
        is_meeting_request: false,
        draft_response: isDirectlyAddressed ? 'Thank you for your email. I will review and respond shortly.' : null
      };
    }
  }

  /**
   * Check calendar availability for a meeting request
   */
  async _checkMeetingAvailability(meetingDetails) {
    const proposedTime = new Date(meetingDetails.proposed_datetime);
    const duration = meetingDetails.duration_minutes || 60;
    const endTime = new Date(proposedTime.getTime() + duration * 60 * 1000);

    // Check availability at proposed time
    const availability = await this.calendar.checkAvailability(proposedTime, endTime);

    const result = {
      is_available: availability.isFree,
      proposed_time: proposedTime.toISOString(),
      proposed_end: endTime.toISOString(),
      duration_minutes: duration
    };

    if (!availability.isFree && availability.conflicts.length > 0) {
      // There's a conflict - get details
      result.conflict = {
        event_name: availability.conflicts[0].summary,
        event_start: availability.conflicts[0].start,
        event_end: availability.conflicts[0].end
      };

      // Find alternative slots in the next 3 days
      try {
        const rangeStart = new Date();
        const rangeEnd = new Date(rangeStart.getTime() + 3 * 24 * 60 * 60 * 1000);
        const freeSlots = await this.calendar.findFreeSlots(rangeStart, rangeEnd, duration, {
          workdayStart: 9,
          workdayEnd: 18,
          excludeWeekends: true
        });

        // Take first 3 suggested slots
        result.suggested_alternatives = freeSlots.slice(0, 3).map(slot => ({
          start: slot.start.toISOString(),
          end: new Date(slot.start.getTime() + duration * 60 * 1000).toISOString(),
          display: this._formatDateTimeNice(slot.start)
        }));
      } catch (err) {
        console.error('[EmailMonitor] Failed to find free slots:', err.message);
      }
    }

    return result;
  }

  /**
   * Format datetime nicely for display
   */
  _formatDateTimeNice(date) {
    const d = new Date(date);
    const options = {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    };
    return d.toLocaleString('en-US', options);
  }

  /**
   * Build notification message for NC Talk
   */
  _buildNotification(email, analysis) {
    const urgencyEmoji = {
      high: '🔴',
      medium: '🟡',
      low: '🟢',
      none: '⚪'
    };

    let message = `📬 **New Email Received**\n\n`;
    message += `**From:** ${email.from}\n`;
    message += `**Subject:** ${email.subject}\n`;
    message += `**Urgency:** ${urgencyEmoji[analysis.urgency] || '⚪'} ${analysis.urgency || 'unknown'}\n\n`;
    message += `**Summary:** ${analysis.summary}\n`;

    // Special handling for meeting requests with calendar context
    if (analysis.is_meeting_request && analysis.calendar_context) {
      const ctx = analysis.calendar_context;
      const meeting = analysis.meeting_details;

      message += `\n📅 **Meeting Request Detected**\n`;
      message += `**Proposed Time:** ${this._formatDateTimeNice(new Date(ctx.proposed_time))}\n`;
      if (meeting?.topic) {
        message += `**Topic:** ${meeting.topic}\n`;
      }
      if (meeting?.location) {
        message += `**Location:** ${meeting.location}\n`;
      }

      if (ctx.is_available) {
        message += `\n✅ **You're FREE at this time!**\n`;
        message += `\n───────────────────\n`;
        message += `**Suggested Response:**\n\n`;
        message += `${analysis.draft_response || 'I am available at that time. I look forward to our meeting!'}\n`;
        message += `───────────────────\n\n`;
        message += `Reply **accept** to confirm the meeting, **decline** to politely decline, or **ignore** to skip.`;
      } else {
        message += `\n⚠️ **CONFLICT:** You have "${ctx.conflict?.event_name}" at that time.\n`;

        if (ctx.suggested_alternatives && ctx.suggested_alternatives.length > 0) {
          message += `\n**Suggested Alternative Times:**\n`;
          ctx.suggested_alternatives.forEach((slot, i) => {
            message += `${i + 1}. ${slot.display}\n`;
          });
          message += `\n───────────────────\n`;
          message += `Reply **suggest** to propose alternatives, **decline** to politely decline, or **accept anyway** to double-book.`;
        } else {
          message += `\n───────────────────\n`;
          message += `Reply **decline** to politely decline, or **accept anyway** to double-book.`;
        }
      }

      return message;
    }

    // Standard email handling
    if (analysis.needs_response && analysis.draft_response) {
      message += `\n───────────────────\n`;
      message += `**Suggested Response:**\n\n`;
      message += `${analysis.draft_response}\n`;
      message += `───────────────────\n\n`;
      message += `Reply **send** to send this response, **edit** to modify, or **ignore** to skip.`;
    } else if (!analysis.needs_response) {
      message += `\n_No response required. ${analysis.reason}_`;
    }

    return message;
  }

  /**
   * Store pending reply for HITL approval
   */
  _storePendingReply(email, analysis) {
    // Store pending email reply using the new PendingActionStore
    const pendingId = pendingEmailReplies.set('email_reply', {
      email: {
        messageId: email.messageId,
        from: email.from,
        fromAddress: email.fromAddress,
        subject: email.subject,
        inReplyTo: email.messageId,
        references: email.references ? `${email.references} ${email.messageId}` : email.messageId
      },
      draft: analysis.draft_response,
      // Meeting-specific context
      is_meeting_request: analysis.is_meeting_request || false,
      meeting_details: analysis.meeting_details || null,
      calendar_context: analysis.calendar_context || null
    });

    console.log(`[EmailMonitor] Stored pending reply: ${pendingId} (meeting: ${analysis.is_meeting_request || false})`);
  }

  /**
   * Mark email as seen in IMAP
   */
  async _markEmailSeen(seqno) {
    const cred = await this.credentials.get('email-imap');
    if (!cred) return;

    return new Promise((resolve, reject) => {
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

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err) => {
          if (err) {
            imap.end();
            return resolve(); // Don't fail on this
          }

          imap.addFlags(seqno, ['\\Seen'], (err) => {
            imap.end();
            resolve();
          });
        });
      });

      imap.once('error', () => resolve()); // Don't fail on this
      imap.connect();
    });
  }

  /**
   * Load processed emails from file
   */
  _loadProcessedEmails() {
    try {
      if (fs.existsSync(this.processedEmailsFile)) {
        const data = fs.readFileSync(this.processedEmailsFile, 'utf8');
        const parsed = JSON.parse(data);
        // Convert to Set for fast lookup
        return new Set(parsed.messageIds || []);
      }
    } catch (err) {
      console.error('[EmailMonitor] Failed to load processed emails:', err.message);
    }
    return new Set();
  }

  /**
   * Save processed emails to file
   */
  _saveProcessedEmails() {
    try {
      // Keep only last 1000 message IDs to prevent unbounded growth
      const messageIds = Array.from(this.processedEmails).slice(-1000);
      fs.writeFileSync(this.processedEmailsFile, JSON.stringify({
        messageIds,
        lastUpdated: new Date().toISOString()
      }, null, 2));
    } catch (err) {
      console.error('[EmailMonitor] Failed to save processed emails:', err.message);
    }
  }

  /**
   * Check if email was already processed
   */
  _isProcessed(messageId) {
    return this.processedEmails.has(messageId);
  }

  /**
   * Mark email as processed
   */
  _markProcessed(messageId) {
    this.processedEmails.add(messageId);
    this._saveProcessedEmails();
  }

  /**
   * Update configuration via natural language
   */
  updateConfig(key, value) {
    if (key === 'notifyRoom') {
      const hadNoRoom = !this.config.notifyRoom;
      this.config.notifyRoom = value;
      console.log(`[EmailMonitor] Notify room updated to: ${value}`);

      // If we just got a room token and have pending notifications, send them
      if (hadNoRoom && value && this._pendingNotifications.length > 0) {
        console.log(`[EmailMonitor] Room token now available, sending ${this._pendingNotifications.length} pending notification(s)`);
        this._sendPendingNotifications();
      }
    }
  }

  /**
   * Send any pending notifications that were queued due to missing room token
   */
  async _sendPendingNotifications() {
    if (!this.config.notifyRoom || !this.sendTalkMessage) {
      return;
    }

    const pending = [...this._pendingNotifications];
    this._pendingNotifications = [];

    for (const item of pending) {
      try {
        // Skip notifications older than 24 hours
        if (Date.now() - item.timestamp > 24 * 60 * 60 * 1000) {
          console.log(`[EmailMonitor] Skipping stale notification for: ${item.email.messageId}`);
          continue;
        }

        await this.sendTalkMessage(this.config.notifyRoom, item.notification);
        await this.auditLog('email_notification_sent', {
          messageId: item.email.messageId,
          room: this.config.notifyRoom,
          needsResponse: item.analysis.needs_response,
          delayed: true
        });

        // If needs response, store pending action for HITL
        if (item.analysis.needs_response && item.analysis.draft_response) {
          this._storePendingReply(item.email, item.analysis);
        }

        // Mark email as seen in IMAP
        await this._markEmailSeen(item.email.seqno);

        console.log(`[EmailMonitor] Sent delayed notification for: ${item.email.subject}`);

      } catch (err) {
        console.error(`[EmailMonitor] Failed to send delayed notification: ${err.message}`);
      }
    }
  }
}

module.exports = EmailMonitor;
