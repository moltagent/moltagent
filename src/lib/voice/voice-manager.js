/**
 * VoiceManager — Mode-aware voice orchestration with STT and TTS reply support
 *
 * Orchestrates voice processing with Cockpit mode awareness.
 * Downloads audio from Nextcloud, converts to WAV, transcribes via SpeachesClient.
 * In 'full' mode also supports TTS voice replies: synthesizes speech, uploads the
 * resulting MP3 to Nextcloud via WebDAV, then shares it into a Talk room.
 * Does NOT call AgentLoop — returns the transcript for the caller to route.
 *
 * Modes:
 *   'off'    — processVoiceMessage returns null immediately
 *   'listen' — download, convert, transcribe, return transcript
 *   'full'   — same as listen plus replyWithVoice() TTS reply capability
 *
 * @module voice/voice-manager
 * @version 2.0.0
 */

'use strict';

const VALID_MODES = new Set(['off', 'listen', 'full']);

class VoiceManager {
  /**
   * @param {Object} options
   * @param {Object} options.speachesClient - SpeachesClient instance for STT/TTS
   * @param {Object} options.fileClient - NCFilesClient instance for downloading audio
   * @param {Object} [options.audioConverter] - AudioConverter for format conversion
   * @param {Object} [options.ncRequestManager] - NCRequestManager for authenticated HTTP requests
   * @param {Object} [options.config] - Voice config from appConfig
   * @param {Object} [options.logger] - Logger instance
   */
  constructor({ speachesClient, fileClient, audioConverter, ncRequestManager, config, logger } = {}) {
    this.speachesClient = speachesClient || null;
    this.fileClient = fileClient || null;
    this.audioConverter = audioConverter || null;
    this.ncRequestManager = ncRequestManager || null;
    this.config = config || {};
    this.logger = logger || console;
    this.mode = 'off';
  }

  /**
   * Set the voice processing mode.
   *
   * @param {string} mode - 'off' | 'listen' | 'full'
   */
  setMode(mode) {
    if (!VALID_MODES.has(mode)) {
      this.logger.warn(`[VoiceManager] Invalid mode "${mode}", keeping "${this.mode}"`);
      return;
    }
    if (mode !== this.mode) {
      this.logger.info(`[VoiceManager] Mode changed: ${this.mode} -> ${mode}`);
      this.mode = mode;
    }
  }

  /**
   * Check if a message object represents a voice message.
   *
   * @param {Object} message - NC Talk message object
   * @returns {boolean}
   */
  isVoiceMessage(message) {
    if (!message) return false;
    if (message.messageType === 'voice-message') return true;
    const file = message.messageParameters?.file;
    if (file) {
      const mime = file.mimetype || '';
      if (mime.startsWith('audio/')) return true;
    }
    return false;
  }

  /**
   * Process a voice message: download, convert, transcribe.
   *
   * @param {Object} message - NC Talk message object (raw)
   * @returns {Promise<{transcript: string, duration: number}|null>}
   *   Returns null if mode is off, transcription fails, or transcript is empty.
   */
  async processVoiceMessage(message) {
    if (this.mode === 'off') {
      return null;
    }

    const startTime = Date.now();

    try {
      const fileInfo = this._extractFileInfo(message);
      if (!fileInfo) {
        this.logger.warn('[VoiceManager] No audio file info found in message');
        return null;
      }

      // 1. Download audio via tiered strategy
      let audioBuffer;
      try {
        audioBuffer = await this._downloadAudioBuffer(fileInfo);
      } catch (err) {
        this.logger.warn(`[VoiceManager] File download failed: ${err.message}`);
        return null;
      }

      if (!audioBuffer || audioBuffer.length === 0) {
        this.logger.warn('[VoiceManager] Downloaded audio buffer is empty');
        return null;
      }

      // 2. Convert to WAV 16kHz mono (if converter available)
      let wavBuffer = audioBuffer;
      if (this.audioConverter) {
        try {
          wavBuffer = await this.audioConverter.toWav16kMono(audioBuffer);
        } catch (err) {
          this.logger.warn(`[VoiceManager] Audio conversion failed: ${err.message}`);
          // Try transcribing raw audio as fallback
          wavBuffer = audioBuffer;
        }
      }

      // 3. Transcribe via SpeachesClient
      let transcript;
      try {
        const language = this.config.language || undefined;
        transcript = await this.speachesClient.transcribe(wavBuffer, { language });
      } catch (err) {
        this.logger.warn(`[VoiceManager] Transcription failed: ${err.message}`);
        return null;
      }

      if (!transcript || transcript.trim().length === 0) {
        return null;
      }

      const duration = Date.now() - startTime;
      this.logger.info(`[VoiceManager] Transcribed (${duration}ms): "${transcript.substring(0, 80)}..."`);

      return { transcript: transcript.trim(), duration };
    } catch (err) {
      this.logger.warn(`[VoiceManager] processVoiceMessage error: ${err.message}`);
      return null;
    }
  }

  /**
   * Check if the voice pipeline is available (Speaches server healthy).
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    if (!this.speachesClient) return false;
    try {
      return await this.speachesClient.isHealthy();
    } catch {
      return false;
    }
  }

  /**
   * Synthesize a TTS reply and share it as a voice message in a Talk room.
   * Only available when mode is 'full'.
   *
   * @param {string} roomToken - Talk room token to share the voice reply into
   * @param {string} text - Text to synthesize
   * @param {Object} [options] - Reserved for future use
   * @returns {Promise<{success: boolean, reason?: string, filename?: string, size?: number}>}
   */
  async replyWithVoice(roomToken, text, options = {}) {
    if (this.mode !== 'full') {
      return { success: false, reason: 'voice_reply_disabled' };
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return { success: false, reason: 'empty_text' };
    }

    try {
      const sanitized = this._sanitizeForSpeech(text);

      // 1. Synthesize speech via SpeachesClient
      let audioBuffer;
      try {
        audioBuffer = await this.speachesClient.synthesize(sanitized, {
          voice: this._getConfiguredVoice()
        });
      } catch (err) {
        this.logger.warn(`[VoiceManager] TTS synthesis failed: ${err.message}`);
        return { success: false, reason: 'tts_failed' };
      }

      // 2. Upload synthesized audio to Nextcloud via WebDAV PUT
      const filename = `voice-reply-${Date.now()}.mp3`;
      const remotePath = `Talk/${filename}`;
      try {
        const username = this.ncRequestManager.ncUser || 'moltagent';
        const webdavPath = `/remote.php/dav/files/${username}/${remotePath}`;
        await this.ncRequestManager.request(webdavPath, {
          method: 'PUT',
          headers: {
            'Content-Type': 'audio/mpeg'
          },
          body: audioBuffer
        });
      } catch (err) {
        this.logger.warn(`[VoiceManager] Audio upload failed: ${err.message}`);
        return { success: false, reason: 'upload_failed' };
      }

      // 3. Share the uploaded file into the Talk room
      try {
        await this._shareInTalk(roomToken, remotePath);
      } catch (err) {
        this.logger.warn(`[VoiceManager] Talk share failed: ${err.message}`);
        return { success: false, reason: 'share_failed' };
      }

      const size = audioBuffer.length;
      this.logger.info(`[VoiceManager] Voice reply shared in room ${roomToken}: ${filename} (${size} bytes)`);
      return { success: true, filename, size };
    } catch (err) {
      this.logger.warn(`[VoiceManager] replyWithVoice error: ${err.message}`);
      return { success: false, reason: 'tts_failed' };
    }
  }

  /**
   * Sanitize text for TTS by stripping markdown and other non-speakable tokens.
   *
   * @param {string} text - Raw text (may contain markdown)
   * @returns {string} Clean, speakable text
   * @private
   */
  _sanitizeForSpeech(text) {
    let out = text;

    // Remove fenced code blocks (``` ... ```) entirely — not speakable
    out = out.replace(/```[\s\S]*?```/g, '');

    // Strip markdown headers (# Heading → Heading)
    out = out.replace(/^#{1,6}\s+/gm, '');

    // Strip bold/italic markers (**text**, __text__, *text*, _text_)
    out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
    out = out.replace(/__([^_]+)__/g, '$1');
    out = out.replace(/\*([^*]+)\*/g, '$1');
    out = out.replace(/_([^_]+)_/g, '$1');

    // Strip inline code (`code` → code)
    out = out.replace(/`([^`]+)`/g, '$1');

    // Replace URLs with the word "link"
    out = out.replace(/https?:\/\/\S+/g, 'link');

    // Strip bullet list markers (- item, * item, 1. item at line start)
    out = out.replace(/^[\t ]*[-*]\s+/gm, '');
    out = out.replace(/^[\t ]*\d+\.\s+/gm, '');

    // Strip common emoji (Unicode ranges: emoticons, misc symbols, supplemental symbols, etc.)
    // Covers U+1F300–U+1FAFF and U+2600–U+27BF
    out = out.replace(/[\u{1F300}-\u{1FAFF}]/gu, '');
    out = out.replace(/[\u{2600}-\u{27BF}]/gu, '');

    // Collapse multiple whitespace characters and newlines into a single space
    out = out.replace(/\s+/g, ' ');

    return out.trim();
  }

  /**
   * Share a Nextcloud file into a Talk room via the OCS Share API.
   *
   * @param {string} roomToken - Talk room token (shareWith value for shareType 10)
   * @param {string} remotePath - Nextcloud file path relative to the user's root (e.g. Talk/foo.mp3)
   * @returns {Promise<Object>} OCS API response
   * @private
   */
  async _shareInTalk(roomToken, remotePath) {
    const body = new URLSearchParams({
      path: remotePath,
      shareType: '10',
      shareWith: roomToken
    }).toString();

    const response = await this.ncRequestManager.request(
      '/ocs/v2.php/apps/files_sharing/api/v1/shares',
      {
        method: 'POST',
        headers: {
          'OCS-APIRequest': 'true',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
      }
    );

    return response;
  }

  /**
   * Return the configured TTS voice identifier, if any.
   *
   * @returns {string|undefined}
   * @private
   */
  _getConfiguredVoice() {
    return this.config.speachesTtsVoice || this.config.ttsVoice || undefined;
  }

  /**
   * Extract audio file info from a message's parameters.
   * Returns the full file object with id, path, link, name, mimetype.
   *
   * @param {Object} message - NC Talk message object
   * @returns {{id: string, path: string, link: string, name: string, mimetype: string}|null}
   * @private
   */
  _extractFileInfo(message) {
    if (!message) return null;
    const params = message.messageParameters;
    if (!params) return null;

    // Primary: messageParameters.file
    if (params.file) return params.file;

    // Numbered file refs: file0, file1, etc.
    for (let i = 0; i <= 9; i++) {
      const key = `file${i}`;
      if (params[key]) return params[key];
    }

    // Alternative: message.file (top-level)
    if (message.file) return message.file;

    return null;
  }

  /**
   * Download audio buffer using a tiered strategy:
   * 1. Bot's Talk/ folder via authenticated WebDAV (NC copies shared files here)
   * 2. Public share WebDAV with share token auth
   * 3. Bare path via NCFilesClient (fallback)
   *
   * @param {Object} fileInfo - File object with id, path, link, name
   * @returns {Promise<Buffer>}
   * @private
   */
  async _downloadAudioBuffer(fileInfo) {
    const fileName = fileInfo.name || fileInfo.path;

    // Strategy 1: Authenticated WebDAV via bot's Talk/ folder
    // NC copies files shared in Talk conversations into each participant's Talk/ folder
    if (fileName && this.fileClient) {
      try {
        const talkPath = `Talk/${fileName}`;
        this.logger.info(`[VoiceManager] Downloading via Talk folder: ${talkPath}`);
        const buffer = await this.fileClient.readFileBuffer(talkPath);
        if (buffer && buffer.length > 0) {
          this.logger.info(`[VoiceManager] Downloaded ${buffer.length} bytes via Talk folder`);
          return buffer;
        }
      } catch (err) {
        this.logger.warn(`[VoiceManager] Talk folder download failed: ${err.message}`);
      }
    }

    // Strategy 2: Public share WebDAV with share token as auth
    if (fileInfo.link && fileName && this.fileClient?.nc) {
      try {
        const shareToken = fileInfo.link.split('/s/').pop();
        if (shareToken) {
          const encodedName = encodeURIComponent(fileName);
          const webdavUrl = `${this.fileClient.nc.ncUrl}/public.php/webdav/${encodedName}`;
          this.logger.info(`[VoiceManager] Downloading via public WebDAV: ${webdavUrl}`);
          const response = await this._publicShareDownload(webdavUrl, shareToken);
          if (response && response.length > 0) {
            this.logger.info(`[VoiceManager] Downloaded ${response.length} bytes via public WebDAV`);
            return response;
          }
        }
      } catch (err) {
        this.logger.warn(`[VoiceManager] Public WebDAV download failed: ${err.message}`);
      }
    }

    // Strategy 3: Bare path via NCFilesClient (fallback for files in bot's root)
    if (fileInfo.path && this.fileClient) {
      try {
        this.logger.info(`[VoiceManager] Trying bare WebDAV path: ${fileInfo.path}`);
        return await this.fileClient.readFileBuffer(fileInfo.path);
      } catch (err) {
        this.logger.warn(`[VoiceManager] Bare WebDAV download failed: ${err.message}`);
      }
    }

    throw new Error('All download strategies exhausted');
  }

  /**
   * Download a file from a NC public share via WebDAV.
   * Uses the share token as Basic Auth username with empty password.
   *
   * @param {string} url - Full WebDAV URL
   * @param {string} shareToken - NC public share token
   * @returns {Promise<Buffer>}
   * @private
   */
  async _publicShareDownload(url, shareToken) {
    const https = require('https');
    const http = require('http');
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = transport.request({
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${shareToken}:`).toString('base64'),
          'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 30000
      }, (res) => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }
}

module.exports = VoiceManager;
