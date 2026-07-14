/**
 * PerceptionCustody — the context window is a custody surface.
 *
 * Architecture Brief:
 * -------------------
 * Problem (Approval Custody Phase 4, #292 / #81): the agent has no senses of
 * its own. Its entire perceptual world is what the substrate hands across the
 * boundary each turn — the assembled conversation history. Two failures live in
 * that perception:
 *
 *   - The imitation generator (#292): enforcer-rendered approval ceremony sits
 *     in Talk history as imitable material. The model reads ceremony text after
 *     a write request and produces the pattern itself (narration without
 *     invocation — #81's original sin). Phase 1 densified the template by
 *     ceremonying every write-class call.
 *   - The poisoning cascade (#292): a false "foi deletado" enters history; the
 *     appended honesty trailer corrects the human-visible surface, but the
 *     model's own earlier claim outweighs an appended contradiction on later
 *     turns ("já deletado"), and only a fresh card name breaks the loop.
 *
 * Design: the Talk record stays complete and honest for humans — every
 * ceremony, claim, and trailer auditable forever. What changes is what the
 * MODEL perceives on its next turn, enforced at the one boundary where truth
 * crosses into the model: context assembly. Corrections land as REPLACEMENT in
 * perception, never as appended contradiction (the authority requirement — a
 * correction carries at least the authority of the claim it corrects).
 *
 * Two mechanisms, both keyed on the created Talk message id (surfaced by
 * TalkSendQueue's {ok, id} contract):
 *   - M1 (ceremony exclusion, Wave B / gated): enforcer-rendered ceremony is
 *     removed from the model's context. While the held invocation is still
 *     pending it is replaced with one compact machine-register STATE line
 *     (`[approval pending: <label> — awaiting human decision]`) so the model
 *     keeps the state without the template; once resolved it is dropped with no
 *     replacement (the turn's own truthful output carries the outcome). The
 *     pending/resolved fact is read LIVE from the enforcer's PendingAction
 *     custody, never re-derived here (signals keep custody, #49 family).
 *   - M2 (correction-as-replacement, Wave A / always on): where a trailer-
 *     corrected false completion stood, the model perceives the corrected form.
 *     The three-attempt poisoning loop becomes impossible: the model cannot
 *     re-read its own fiction.
 *
 * Identification is STRUCTURAL, never semantic — by message id (our own id for
 * our own message), never by reading natural-language content. This is plumbing
 * on ids, not intelligence on text (Rule 1).
 *
 * Registries are in-memory and per-process. A restart forgets them, so
 * pre-restart ceremony/correction text can resurface in assembled context until
 * it ages out of the context window. The realistic poisoning window (minutes)
 * is covered; the limitation is documented, not papered over. No persistence is
 * built unless production shows a post-restart resurrection actually biting.
 *
 * @module agent/perception-custody
 */

'use strict';

/**
 * The machine-register form the model perceives where a trailer-corrected false
 * completion stood (M2). Model-facing English, square-bracketed, never
 * localized, sharing zero surface with any user-facing string — a replacement
 * that carries the authority of a fact, not an appended contradiction.
 * @type {string}
 */
const NO_ACTION_PERCEPTION = '[No action was executed this turn.]';

class PerceptionCustody {
  /**
   * @param {Object} [deps]
   * @param {Object} [deps.logger] - logger with info/debug (defaults to console)
   */
  constructor({ logger } = {}) {
    this.logger = logger || console;

    /** @type {Map<string, Map<number, {recordId: (string|number|null), label: (string|null)}>>}
     *  roomToken -> (ceremony message id -> descriptor). M1. */
    this._ceremony = new Map();

    /** @type {Map<string, Map<number, string>>}
     *  roomToken -> (message id -> corrected form). M2. */
    this._corrections = new Map();

    /** @type {Map<string, string>} roomToken -> staged correctedForm awaiting its
     *  sent message id. The honesty trailer fires in the agent loop where the
     *  outgoing message is still text (its id is only known after the send), so
     *  M2 stages the correction here and commits it with the real id at the send
     *  site. Single slot per room: same-room turns are serialised in practice
     *  (Talk delivers sequentially; the send queue is FIFO), so a staged form
     *  belongs to the turn about to send. A rare concurrent same-room send could
     *  mis-key one correction; it self-heals as it ages out of the context
     *  window — §2's accepted in-memory semantics, documented not papered over. */
    this._staged = new Map();

    /** M1 exclusion gate. Wave B, Cockpit-governed, default OFF. M2 (corrections)
     *  is NOT gated by this — it ships in Wave A and is always active. */
    this.ceremonyExclusionEnabled = false;
  }

  /**
   * Toggle M1 ceremony exclusion. Propagated from Cockpit system settings on the
   * heartbeat (standing-policy precedent). Only an explicit boolean moves it.
   * @param {boolean} on
   */
  setCeremonyExclusion(on) {
    const next = on === true;
    if (next !== this.ceremonyExclusionEnabled) {
      this.logger.info(`[PerceptionCustody] ceremonyExclusion ${this.ceremonyExclusionEnabled} -> ${next}`);
      this.ceremonyExclusionEnabled = next;
    }
  }

  /**
   * Record a ceremony message the enforcer just sent (M1 primary id path).
   * @param {string} roomToken
   * @param {number} messageId - the created Talk message id (from {ok, id})
   * @param {Object} [meta]
   * @param {string|number|null} [meta.recordId] - the PendingAction this ceremony
   *   belongs to, when it has one; used to read pending/resolved live at assembly.
   * @param {string|null} [meta.label] - the held tool's label, for the state line.
   */
  noteCeremony(roomToken, messageId, { recordId = null, label = null } = {}) {
    const id = Number(messageId);
    if (!roomToken || !Number.isFinite(id)) return;
    let room = this._ceremony.get(roomToken);
    if (!room) { room = new Map(); this._ceremony.set(roomToken, room); }
    room.set(id, { recordId, label });
  }

  /**
   * Record a correction (M2): the model must perceive `correctedForm` where the
   * message with `messageId` (a trailer-corrected false claim) stood.
   * @param {string} roomToken
   * @param {number} messageId - the id of the emitted (corrected) bot message
   * @param {string} correctedForm - the machine-register replacement content
   */
  noteCorrection(roomToken, messageId, correctedForm) {
    const id = Number(messageId);
    if (!roomToken || !Number.isFinite(id) || !correctedForm) return;
    let room = this._corrections.get(roomToken);
    if (!room) { room = new Map(); this._corrections.set(roomToken, room); }
    room.set(id, correctedForm);
  }

  /**
   * Stage a correction whose message id is not yet known (the trailer just fired
   * on an outgoing message that has not been sent). The send site commits it with
   * the real id via {@link noteCorrection}. Last-staged-wins per room.
   * @param {string} roomToken
   * @param {string} correctedForm
   */
  stageCorrection(roomToken, correctedForm) {
    if (!roomToken || !correctedForm) return;
    this._staged.set(roomToken, correctedForm);
  }

  /**
   * Read and clear the staged correction for a room. Called at the send site
   * once the outgoing message id is known.
   * @param {string} roomToken
   * @returns {string|null}
   */
  takeStagedCorrection(roomToken) {
    const form = this._staged.get(roomToken);
    if (form !== undefined) this._staged.delete(roomToken);
    return form == null ? null : form;
  }

  /**
   * Transform assembled history into the model's perception (M1 + M2). Pure over
   * its inputs — it never mutates the passed history nor the registries, and it
   * returns a fresh array so the caller's Talk-facing copy is untouched.
   *
   * @param {Array<{id: *, role: string, content: string}>} history - getHistory() output
   * @param {string} roomToken
   * @param {Object} [opts]
   * @param {Array<{id: *}>} [opts.pendingRecords] - the room's LIVE PendingAction
   *   records (authoritative pending state, read from the enforcer — never re-derived).
   * @returns {{history: Array, stats: {excluded: number, replaced: number, corrected: number}}}
   */
  redactForModel(history, roomToken, { pendingRecords = [] } = {}) {
    const stats = { excluded: 0, replaced: 0, corrected: 0 };
    if (!Array.isArray(history) || history.length === 0) {
      return { history: Array.isArray(history) ? history : [], stats };
    }

    const corrections = this._corrections.get(roomToken) || null;
    const ceremonyIds = this.ceremonyExclusionEnabled ? (this._ceremony.get(roomToken) || null) : null;
    const livePending = new Set((pendingRecords || []).map(r => r && r.id).filter(v => v != null));

    // Nothing to do for this room → return the original array unchanged.
    if (!corrections && !ceremonyIds) return { history, stats };

    // A batch record sends several ceremony messages sharing one recordId; the
    // model needs exactly ONE pending state line for it, not one per message.
    const pendingLineEmitted = new Set();

    const out = [];
    for (const entry of history) {
      const mid = Number(entry.id);

      // M2 first: a corrected claim is replaced in perception. Talk keeps the
      // claim + trailer; the model reads only the correction.
      if (corrections && corrections.has(mid)) {
        out.push({ ...entry, content: corrections.get(mid) });
        stats.corrected++;
        continue;
      }

      // M1: enforcer ceremony leaves the model's perception (gated).
      if (ceremonyIds && ceremonyIds.has(mid)) {
        const meta = ceremonyIds.get(mid);
        if (meta.recordId != null && livePending.has(meta.recordId)) {
          // Still pending → keep the STATE, drop the template. One line per record.
          if (pendingLineEmitted.has(meta.recordId)) {
            stats.excluded++;
          } else {
            pendingLineEmitted.add(meta.recordId);
            out.push({ ...entry, content: this._pendingLine(meta.label) });
            stats.replaced++;
          }
        } else {
          // Resolved / no live record → drop entirely.
          stats.excluded++;
        }
        continue;
      }

      out.push(entry);
    }

    return { history: out, stats };
  }

  /**
   * The machine-register replacement line for a pending ceremony. English,
   * square-bracketed, never localized (model-facing only), no emoji, no
   * approval-word instruction. It shares zero surface with any user-facing
   * ceremony string in any language: there is nothing to imitate.
   * @param {string|null} label
   * @returns {string}
   * @private
   */
  _pendingLine(label) {
    const what = (label && String(label).trim()) || 'a state-changing tool';
    return `[approval pending: ${what} — awaiting human decision]`;
  }

  /**
   * Drop all registry state for a room. Not wired to any lifecycle today; here
   * so a future room-close/reset can bound memory without reaching into fields.
   * @param {string} roomToken
   */
  forgetRoom(roomToken) {
    this._ceremony.delete(roomToken);
    this._corrections.delete(roomToken);
  }
}

module.exports = { PerceptionCustody, NO_ACTION_PERCEPTION };
