/**
 * TalkSendQueue — serializes outbound Talk messages.
 *
 * Multiple components (MessageProcessor, EmailMonitor, HeartbeatManager)
 * may send Talk messages concurrently. Without serialization, messages
 * can arrive out of order. This queue ensures FIFO delivery.
 *
 * Each process (webhook-server, bot) gets its own instance.
 *
 * @module talk/talk-send-queue
 */

const { ocsData } = require('../shared/ocs-response');

/**
 * @typedef {Object} SendResult
 * @property {boolean} ok - true when the message was delivered (or was an
 *   empty no-op); false on a delivery error.
 * @property {number|null} id - the created Talk message id when the send path
 *   returned one, else null. Perception Custody (Phase 4) keys its ceremony-
 *   exclusion (M1) and correction-as-replacement (M2) registries on this id.
 *   Empty no-ops and failures carry id:null.
 */

class TalkSendQueue {
  // NC Talk message limit is ~32KB; truncate below that with buffer for JSON overhead
  static MAX_MESSAGE_LENGTH = 30000;

  /**
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {Object} [logger=console] - Logger with .log/.warn/.error methods
   */
  constructor(ncRequestManager, logger) {
    this.nc = ncRequestManager;
    this.logger = logger || console;
    this.queue = [];         // Array of { token, message, replyTo, resolve, reject }
    this.processing = false;
    this._drainPromise = null; // Resolves when current _drain() finishes
    this.metrics = { sent: 0, failed: 0, maxDepth: 0 };
  }

  /**
   * Enqueue a Talk message for sequential delivery.
   * Returns a promise that resolves when the message is actually sent.
   *
   * @param {string} token - Talk room token
   * @param {string} message - Message text
   * @param {number|null} [replyTo=null] - Message ID to reply to
   * @returns {Promise<SendResult>} resolves to {ok, id}. Read `.ok` for
   *   success — the object is always truthy, so a bare `if (await enqueue())`
   *   would treat a failure as success. `.id` carries the created message id
   *   when the send returned one.
   */
  enqueue(token, message, replyTo = null) {
    // Coerce non-string messages (e.g. objects from executor pipelines)
    if (typeof message !== 'string') {
      message = (message && message.response) ? String(message.response) : String(message || '');
    }
    // Strip <think> reasoning tags from LLM responses
    let sanitized = message;
    if (typeof sanitized === 'string') {
      // Handle incomplete think blocks (model timed out mid-reasoning)
      if (sanitized.startsWith('<think>') && !sanitized.includes('</think>')) {
        sanitized = '';
      } else {
        sanitized = sanitized.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }
    }

    // Don't send empty messages. A no-op is a success with no message id.
    if (!sanitized) {
      return Promise.resolve({ ok: true, id: null });
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ token, message: sanitized, replyTo, resolve, reject });
      if (this.queue.length > this.metrics.maxDepth) {
        this.metrics.maxDepth = this.queue.length;
      }
      this._drain();
    });
  }

  /**
   * Process queued messages one at a time.
   * Re-entrant safe: if already processing, returns the existing drain promise.
   */
  _drain() {
    if (this.processing) return this._drainPromise;
    if (this.queue.length === 0) return Promise.resolve();
    this.processing = true;
    this._drainPromise = this._doDrain();
    return this._drainPromise;
  }

  async _doDrain() {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        const result = await this._send(item.token, item.message, item.replyTo);
        item.resolve(result);
      } catch (err) {
        this.metrics.failed++;
        item.reject(err);
      }
    }
    this.processing = false;
    this._drainPromise = null;
  }

  /**
   * Truncate a message to fit within Talk's size limit.
   * Cuts at a natural boundary (paragraph/line) and appends a helpful notice.
   * @param {string} msg
   * @param {number} limit
   * @returns {string}
   */
  _truncateMessage(msg, limit) {
    if (msg.length <= limit) return msg;
    const slice = msg.substring(0, limit);
    // Cut at last paragraph break, or line break if no paragraph break in the last 20%
    const lastParagraph = slice.lastIndexOf('\n\n');
    const lastLine = slice.lastIndexOf('\n');
    const cutPoint = lastParagraph > limit * 0.8 ? lastParagraph
      : lastLine > limit * 0.8 ? lastLine
      : limit;
    const totalKB = (msg.length / 1024).toFixed(1);
    return slice.substring(0, cutPoint) +
      `\n\n[Content truncated — full content is ${totalKB} KB. Ask me to summarize or show a specific section.]`;
  }

  /**
   * Send a single Talk message via NCRequestManager.
   * Pre-truncates oversized messages; retries with shorter truncation on 413.
   * @returns {Promise<SendResult>} {ok, id}
   */
  async _send(token, message, replyTo) {
    // Pre-truncate to avoid 413
    const text = this._truncateMessage(message, TalkSendQueue.MAX_MESSAGE_LENGTH);

    const result = await this._sendOnce(token, text, replyTo);
    if (result === '413') {
      // Retry with aggressive truncation (halve the limit)
      this.logger.warn(`[TalkSendQueue] 413 on pre-truncated message (${text.length} chars), retrying at half length`);
      const shorter = this._truncateMessage(message, Math.floor(TalkSendQueue.MAX_MESSAGE_LENGTH / 2));
      const retry = await this._sendOnce(token, shorter, replyTo);
      if (retry === '413') {
        this.metrics.failed++;
        return { ok: false, id: null };
      }
      return retry;
    }
    return result;
  }

  /**
   * Send a single message attempt.
   * @returns {Promise<SendResult|'413'>} {ok, id} on a completed attempt
   *   (ok:false on a >=400 status), or the internal '413' sentinel so `_send`
   *   can retry at half length.
   */
  async _sendOnce(token, message, replyTo) {
    const body = { message };
    if (replyTo != null) {
      body.replyTo = replyTo;
    }
    try {
      const response = await this.nc.request(
        `/ocs/v2.php/apps/spreed/api/v1/chat/${token}`,
        {
          method: 'POST',
          headers: {
            'OCS-APIRequest': 'true',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body
        }
      );
      if (response.status === 413) return '413';
      if (response.status >= 400) {
        this.metrics.failed++;
        return { ok: false, id: null };
      }
      this.metrics.sent++;
      // NC Talk's chat POST returns the created chat message in ocs.data; its
      // id is the substrate handle Perception Custody's M1/M2 registries key on.
      // Parsing our own OCS response for our own id is plumbing (like reading
      // ocs.data.id elsewhere), not content inspection.
      return { ok: true, id: this._extractMessageId(response) };
    } catch (err) {
      // NCRequestManager may throw on 413 instead of returning status
      if (err.message && err.message.includes('413')) return '413';
      throw err;
    }
  }

  /**
   * Pull the created message id out of a Talk chat POST response. Tolerant of a
   * missing/oddly-shaped body — returns null rather than a NaN id, so the
   * registries never key on garbage.
   * @param {Object} response - NCRequestManager response ({status, headers, body})
   * @returns {number|null}
   * @private
   */
  _extractMessageId(response) {
    const raw = ocsData(response)?.id;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  }

  /**
   * Drain remaining messages before shutdown.
   */
  async shutdown() {
    // Wait for any in-progress drain to finish (it processes all queued items)
    if (this._drainPromise) {
      await this._drainPromise;
    }
    // If items were added after the drain started, drain again
    if (this.queue.length > 0) {
      await this._drain();
    }
  }

  /**
   * @returns {{ sent: number, failed: number, maxDepth: number, pending: number }}
   */
  getMetrics() {
    return { ...this.metrics, pending: this.queue.length };
  }
}

module.exports = { TalkSendQueue };
