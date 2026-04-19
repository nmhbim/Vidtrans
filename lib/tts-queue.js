// lib/tts-queue.js

/**
 * TTSQueue — manages Web Speech Synthesis sequential playback
 *
 * Usage:
 *   const tts = new TTSQueue();
 *   tts.speak('Xin chào');        // Add to queue
 *   tts.speak('Thế giới');       // Will play after first sentence
 *   tts.cancel();                 // Stop everything
 */

const VI_VOICE = 'vi-VN';

export class TTSQueue {
  /**
   * @param {Object} [options]
   * @param {string} [options.lang='vi-VN'] - Target language
   * @param {number} [options.rate=1.0] - Speech rate
   * @param {number} [options.pitch=1.0] - Speech pitch
   * @param {number} [options.volume=1.0] - Speech volume
   * @param {Function} [options.onStart] - Callback when speech starts
   * @param {Function} [options.onEnd] - Callback when speech ends
   * @param {Function} [options.onError] - Callback on error
   */
  constructor(options = {}) {
    this.lang = options.lang || VI_VOICE;
    this.rate = options.rate || 1.0;
    this.pitch = options.pitch || 1.0;
    this.volume = options.volume || 1.0;
    this.onStart = options.onStart || null;
    this.onEnd = options.onEnd || null;
    this.onError = options.onError || null;

    /** @type {string[]} */
    this._queue = [];
    this._isPlaying = false;
    this._isPaused = false;
  }

  /**
   * Add text to the queue and start playing if not already
   * @param {string} text
   */
  speak(text) {
    if (!text || typeof text !== 'string') return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Avoid duplicates (if same text already queued or playing)
    if (this._queue.includes(trimmed)) return;

    this._queue.push(trimmed);

    if (!this._isPlaying) {
      this._playNext();
    }
  }

  /**
   * Pause current speech
   */
  pause() {
    if (this._isPlaying && !this._isPaused) {
      speechSynthesis.pause();
      this._isPaused = true;
    }
  }

  /**
   * Resume paused speech
   */
  resume() {
    if (this._isPaused) {
      speechSynthesis.resume();
      this._isPaused = false;
    }
  }

  /**
   * Cancel all speech and clear queue
   */
  cancel() {
    speechSynthesis.cancel();
    this._queue = [];
    this._isPlaying = false;
    this._isPaused = false;
  }

  /**
   * Check if currently speaking
   * @returns {boolean}
   */
  get isSpeaking() {
    return speechSynthesis.speaking;
  }

  /**
   * Check if there are pending utterances
   * @returns {boolean}
   */
  get hasPending() {
    return speechSynthesis.pending;
  }

  /**
   * Get number of items in queue
   * @returns {number}
   */
  get queueLength() {
    return this._queue.length;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _playNext() {
    if (this._queue.length === 0) {
      this._isPlaying = false;
      this._isPaused = false;
      return;
    }

    this._isPlaying = true;
    this._isPaused = false;
    const text = this._queue.shift();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = this.lang;
    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
    utterance.volume = this.volume;

    // Try to pick a Vietnamese voice if available
    const voices = speechSynthesis.getVoices();
    const viVoice = voices.find(v => v.lang.startsWith('vi'));
    if (viVoice) {
      utterance.voice = viVoice;
    }

    utterance.onstart = () => {
      if (this.onStart) this.onStart(text);
    };

    utterance.onend = () => {
      this._playNext();
    };

    utterance.onerror = (event) => {
      // Ignore 'interrupted' errors (from cancel())
      if (event.error === 'interrupted' || event.error === 'canceled') {
        return;
      }
      if (this.onError) this.onError(event.error);
      // Continue to next even on error
      this._playNext();
    };

    speechSynthesis.speak(utterance);
  }
}
