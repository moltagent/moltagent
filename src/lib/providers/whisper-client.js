/**
 * WhisperClient — HTTP client for whisper.cpp server (OpenAI-compatible API)
 *
 * Sends audio buffers as multipart uploads to /v1/audio/transcriptions
 * and returns the transcribed text.
 *
 * @module providers/whisper-client
 * @version 1.0.0
 */

'use strict';

class WhisperClient {
  /**
   * @param {Object} config
   * @param {string} [config.whisperUrl] - Base URL of whisper.cpp server
   * @param {number} [config.whisperTimeout] - Request timeout in ms
   * @param {string} [config.whisperModel] - Model name to request
   */
  constructor(config = {}) {
    this.baseUrl = (config.whisperUrl || 'http://138.201.246.236:8178').replace(/\/+$/, '');
    this.timeout = config.whisperTimeout || 60000;
    this.model = config.whisperModel || 'small';
  }

  /**
   * Transcribe audio buffer to text via Whisper API.
   *
   * @param {Buffer} audioBuffer - Audio data (WAV 16kHz mono recommended)
   * @param {string} [language] - Optional language hint (e.g. 'en', 'de')
   * @returns {Promise<string>} Transcribed text
   * @throws {Error} On network/server errors
   */
  async transcribe(audioBuffer, language = null) {
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', blob, 'audio.wav');
    formData.append('model', this.model);
    if (language) {
      formData.append('language', language);
    }

    const url = `${this.baseUrl}/v1/audio/transcriptions`;
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(this.timeout)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Whisper API error ${response.status}: ${body.substring(0, 200)}`);
    }

    const result = await response.json();
    return (result.text || '').trim();
  }

  /**
   * Check if the Whisper server is reachable.
   *
   * @returns {Promise<boolean>} true if server responds, false otherwise
   */
  async healthCheck() {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

module.exports = WhisperClient;
