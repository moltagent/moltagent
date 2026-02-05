/**
 * VoiceManager — Mode-aware voice orchestration
 *
 * Orchestrates voice processing with Cockpit mode awareness.
 * Downloads audio from Nextcloud, converts to WAV, transcribes via SpeachesClient.
 * Does NOT call AgentLoop — returns the transcript for the caller to route.
 *
 * Modes:
 *   'off'    — processVoiceMessage returns null immediately
 *   'listen' — download, convert, transcribe, return transcript
 *   'full'   — same as listen (future: may add TTS response)
 *
 * @module voice/voice-manager
 * @version 1.0.0
 */

'use strict';

const VALID_MODES = new Set(['off', 'listen', 'full']);

class VoiceManager {
  /**
   * @param {Object} options
   * @param {Object} options.speachesClient - SpeachesClient instance for STT/TTS
   * @param {Object} options.fileClient - NCFilesClient instance for downloading audio
   * @param {Object} [options.audioConverter] - AudioConverter for format conversion
   * @param {Object} [options.config] - Voice config from appConfig
   * @param {Object} [options.logger] - Logger instance
   */
  constructor({ speachesClient, fileClient, audioConverter, config, logger } = {}) {
    this.speachesClient = speachesClient || null;
    this.fileClient = fileClient || null;
    this.audioConverter = audioConverter || null;
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
