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
    this.baseUrl = (config.whisperUrl || 'http://YOUR_OLLAMA_IP:8014').replace(/\/+$/, '');
    this.timeout = config.whisperTimeout || 60000;
    this.model = config.whisperModel || 'small';
  }

  /**
   * Transcribe audio buffer to text via Whisper API.
   *
   * @param {Buffer} audioBuffer - Audio data (WAV 16kHz mono recommended)
   * @param {string} [language] - Optional language hint (e.g. 'en', 'de')
   * @returns {Promise<{text: string, confidence: number|null}>} Transcription result with optional confidence
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
    const text = (result.text || '').trim();

    // Extract confidence from verbose response if available.
    // whisper.cpp may return segments with avg_logprob.
    let confidence = null;
    if (Array.isArray(result.segments) && result.segments.length > 0) {
      const avgLogprob = result.segments.reduce((sum, s) => sum + (s.avg_logprob || 0), 0) / result.segments.length;
      confidence = Math.min(1, Math.max(0, 1 + avgLogprob));
    }

    return { text, confidence };
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
