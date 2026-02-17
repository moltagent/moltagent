/**
 * DeferralQueue — Persist complex tasks for later processing when
 * cloud resources become available.
 *
 * Tasks are stored in Nextcloud Files as JSON and processed during
 * HeartbeatManager pulse() when cloud providers are reachable.
 *
 * @module agent/deferral-queue
 * @version 1.0.0
 */

'use strict';

const DEFERRAL_FILE_PATH = 'Moltagent/deferred-tasks.json';

class DeferralQueue {
  /**
   * @param {Object} config
   * @param {Object} config.ncFilesClient - NCFilesClient instance
   * @param {Object} config.llmRouter - LLMRouter instance (real router, not legacy)
   * @param {Object} [config.logger] - Logger (default: console)
   */
  constructor(config = {}) {
    this.ncFilesClient = config.ncFilesClient;
    this.llmRouter = config.llmRouter;
    this.logger = config.logger || console;

    this._queue = [];
    this._processing = false;

    this.stats = {
      enqueued: 0,
      processed: 0,
      failed: 0
    };
  }

  /**
   * Add a task to the queue and persist to NC Files.
   * @param {Object} task - { message, userName, roomToken, createdAt }
   * @returns {Promise<void>}
   */
  async enqueue(task) {
    this._queue.push({
      id: `def-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      status: 'queued',
      ...task,
      enqueuedAt: new Date().toISOString()
    });
    this.stats.enqueued++;

    await this._persist();
    this.logger.log(`[DeferralQueue] Task enqueued (queue: ${this._queue.length})`);
  }

  /**
   * Process queued tasks when cloud is available.
   * Called by HeartbeatManager during pulse().
   * @param {Object} agentLoop - AgentLoop instance for full processing
   * @param {number} [maxTasks=2] - Max tasks to process per call
   * @returns {Promise<Object>} { processed, skipped, errors }
   */
  async processNext(agentLoop, maxTasks = 2) {
    if (this._processing) {
      return { processed: 0, skipped: 0, errors: [], reason: 'already_processing' };
    }

    const queued = this._queue.filter(t => t.status === 'queued');
    if (queued.length === 0) {
      return { processed: 0, skipped: 0, errors: [] };
    }

    // Check cloud availability
    let cloudAvailable = false;
    try {
      cloudAvailable = await this.llmRouter.isCloudAvailable();
    } catch {
      cloudAvailable = false;
    }

    if (!cloudAvailable) {
      return { processed: 0, skipped: queued.length, errors: [], reason: 'cloud_unavailable' };
    }

    this._processing = true;
    const results = { processed: 0, skipped: 0, errors: [] };

    try {
      const batch = queued.slice(0, maxTasks);

      for (const task of batch) {
        try {
          task.status = 'processing';

          if (agentLoop) {
            await agentLoop.process(task.message, task.roomToken, {
              inputType: 'deferred',
              deferredTask: true
            });
          } else {
            // Fallback: route through LLM directly
            await this.llmRouter.route({
              job: 'thinking',
              content: task.message,
              requirements: { maxTokens: 1000 }
            });
          }

          task.status = 'done';
          task.completedAt = new Date().toISOString();
          results.processed++;
          this.stats.processed++;
        } catch (err) {
          task.status = 'failed';
          task.error = err.message;
          results.errors.push({ id: task.id, error: err.message });
          this.stats.failed++;
          this.logger.warn(`[DeferralQueue] Task ${task.id} failed: ${err.message}`);
        }
      }

      // Remove completed/failed tasks older than 24h
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      this._queue = this._queue.filter(t => {
        if (t.status === 'queued' || t.status === 'processing') return true;
        const completedTime = t.completedAt ? new Date(t.completedAt).getTime() : Date.now();
        return completedTime > cutoff;
      });

      await this._persist();
    } finally {
      this._processing = false;
    }

    return results;
  }

  /**
   * Load queue state from NC Files.
   * @returns {Promise<void>}
   */
  async load() {
    try {
      const file = await this.ncFilesClient.readFile(DEFERRAL_FILE_PATH);
      if (file && file.content) {
        const data = JSON.parse(file.content);
        this._queue = Array.isArray(data) ? data : (data.queue || []);
        this.logger.log(`[DeferralQueue] Loaded ${this._queue.length} task(s) from storage`);
      }
    } catch (err) {
      if (err.statusCode === 404 || err.message?.includes('not found')) {
        this._queue = [];
        this.logger.log('[DeferralQueue] No existing queue file, starting fresh');
      } else {
        this.logger.warn(`[DeferralQueue] Load failed: ${err.message}`);
        this._queue = [];
      }
    }
  }

  /**
   * Get queue status summary.
   * @returns {Object}
   */
  getStatus() {
    const counts = { queued: 0, processing: 0, done: 0, failed: 0 };
    for (const task of this._queue) {
      counts[task.status] = (counts[task.status] || 0) + 1;
    }
    return {
      total: this._queue.length,
      ...counts,
      stats: { ...this.stats }
    };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Persist queue to NC Files.
   * @returns {Promise<void>}
   * @private
   */
  async _persist() {
    try {
      await this.ncFilesClient.writeFile(
        DEFERRAL_FILE_PATH,
        JSON.stringify(this._queue, null, 2)
      );
    } catch (err) {
      this.logger.warn(`[DeferralQueue] Persist failed: ${err.message}`);
    }
  }
}

module.exports = DeferralQueue;
