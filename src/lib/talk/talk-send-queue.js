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

class TalkSendQueue {
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
   * @returns {Promise<boolean>} true if sent successfully
   */
  enqueue(token, message, replyTo = null) {
    return new Promise((resolve, reject) => {
      this.queue.push({ token, message, replyTo, resolve, reject });
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
   * Send a single Talk message via NCRequestManager.
   * @returns {Promise<boolean>}
   */
  async _send(token, message, replyTo) {
    const body = { message };
    if (replyTo != null) {
      body.replyTo = replyTo;
    }
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
    if (response.status >= 400) {
      this.metrics.failed++;
      return false;
    }
    this.metrics.sent++;
    return true;
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
