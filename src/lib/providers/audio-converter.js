/**
 * AudioConverter — ffmpeg wrapper for audio format conversion
 *
 * Converts voice message audio (OGG/MP3/M4A) to WAV 16kHz mono,
 * which is the format expected by Whisper STT.
 *
 * @module providers/audio-converter
 * @version 1.0.0
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class AudioConverter {
  /**
   * @param {Object} config
   * @param {string} [config.ffmpegPath] - Path to ffmpeg binary
   */
  constructor(config = {}) {
    this.ffmpegPath = config.ffmpegPath || 'ffmpeg';
  }

  /**
   * Convert audio buffer to WAV 16kHz mono.
   *
   * @param {Buffer} inputBuffer - Input audio data (any ffmpeg-supported format)
   * @returns {Promise<Buffer>} WAV 16kHz mono audio buffer
   * @throws {Error} On conversion failure
   */
  async toWav16kMono(inputBuffer) {
    const timestamp = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `moltagent-voice-${timestamp}-${rand}.input`);
    const outputPath = path.join(tmpDir, `moltagent-voice-${timestamp}-${rand}.wav`);

    try {
      // Write input buffer to temp file
      fs.writeFileSync(inputPath, inputBuffer);

      // Run ffmpeg conversion
      await this._runFfmpeg([
        '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        outputPath,
        '-y'
      ]);

      // Read converted output
      const outputBuffer = fs.readFileSync(outputPath);
      return outputBuffer;
    } finally {
      // Always clean up temp files
      this._cleanupFile(inputPath);
      this._cleanupFile(outputPath);
    }
  }

  /**
   * Check if ffmpeg is available on the system.
   *
   * @returns {Promise<boolean>} true if ffmpeg is found, false otherwise
   */
  async isAvailable() {
    return new Promise((resolve) => {
      execFile(this.ffmpegPath, ['-version'], { timeout: 5000 }, (error) => {
        resolve(!error);
      });
    });
  }

  /**
   * Run ffmpeg with the given arguments.
   * @private
   * @param {string[]} args - ffmpeg arguments
   * @returns {Promise<void>}
   */
  _runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      execFile(this.ffmpegPath, args, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`ffmpeg failed: ${error.message} — ${(stderr || '').substring(0, 200)}`));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Silently remove a file if it exists.
   * @private
   * @param {string} filePath
   */
  _cleanupFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

module.exports = AudioConverter;
