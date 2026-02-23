/**
 * SpeachesClient — HTTP client for Speaches STT/TTS server (OpenAI-compatible API)
 *
 * Sends audio buffers as multipart uploads to /v1/audio/transcriptions (STT)
 * and generates speech via /v1/audio/speech (TTS).
 *
 * @module voice/speaches-client
 * @version 1.0.0
 */

'use strict';

class SpeachesClient {
  /**
   * @param {Object} config
   * @param {string} config.endpoint - Base URL of Speaches server (required)
   * @param {string} [config.sttModel] - STT model name
   * @param {string} [config.ttsModel] - TTS model name
   * @param {string} [config.ttsVoice] - TTS voice identifier
   * @param {number} [config.timeout] - Request timeout in ms
   * @param {Object} [config.logger] - Logger instance
   */
  constructor(config = {}) {
    if (!config.endpoint) {
      throw new Error('SpeachesClient requires an endpoint URL');
    }
    this.baseUrl = config.endpoint.replace(/\/+$/, '');
    this.sttModel = config.sttModel || 'Systran/faster-whisper-large-v3';
    this.ttsModel = config.ttsModel || 'piper';
    this.ttsVoice = config.ttsVoice || 'en_US-amy-medium';
    this.timeout = config.timeout || 30000;
    this.logger = config.logger || null;
  }

  /**
   * Transcribe audio buffer to text via Speaches STT API.
   *
   * @param {Buffer} audioBuffer - Audio data (WAV 16kHz mono recommended)
   * @param {Object} [options]
   * @param {string} [options.language] - Optional language hint (e.g. 'en', 'de')
   * @returns {Promise<{text: string, confidence: number|null}>} Transcription result with optional confidence
   * @throws {Error} On network/server errors
   */
  async transcribe(audioBuffer, options = {}) {
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', blob, 'audio.wav');
    formData.append('model', this.sttModel);
    if (options.language) {
      formData.append('language', options.language);
    }

    const url = `${this.baseUrl}/v1/audio/transcriptions`;
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(this.timeout)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Speaches STT error ${response.status}: ${body.substring(0, 200)}`);
    }

    const result = await response.json();
    const text = (result.text || '').trim();

    // Extract confidence from verbose response if available.
    // Speaches/faster-whisper may return segments with avg_logprob.
    let confidence = null;
    if (Array.isArray(result.segments) && result.segments.length > 0) {
      const avgLogprob = result.segments.reduce((sum, s) => sum + (s.avg_logprob || 0), 0) / result.segments.length;
      // avg_logprob is typically -0.5 to 0; map to 0–1 range
      confidence = Math.min(1, Math.max(0, 1 + avgLogprob));
    }

    return { text, confidence };
  }

  /**
   * Synthesize text to speech via Speaches TTS API.
   *
   * @param {string} text - Text to synthesize
   * @param {Object} [options]
   * @param {string} [options.voice] - Override default voice
   * @param {string} [options.response_format] - Audio format (default: 'wav')
   * @returns {Promise<Buffer>} Audio data buffer
   * @throws {Error} On network/server errors
   */
  async synthesize(text, options = {}) {
    const url = `${this.baseUrl}/v1/audio/speech`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.ttsModel,
        input: text,
        voice: options.voice || this.ttsVoice,
        response_format: options.response_format || 'wav'
      }),
      signal: AbortSignal.timeout(this.timeout)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Speaches TTS error ${response.status}: ${body.substring(0, 200)}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Check if the Speaches server is reachable.
   *
   * @returns {Promise<boolean>} true if server responds, false otherwise
   */
  async isHealthy() {
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

module.exports = SpeachesClient;
