/**
 * BaseTTS — Abstract interface for all TTS engines.
 *
 * Contract:
 *   speak(text, rate, voice) → Promise<void>
 *     - Synthesizes and plays ONE text segment
 *     - Resolves when audio playback finishes
 *     - Rejects on error or timeout
 *     - Calling stop() while speaking causes the promise to resolve (not reject)
 *
 *   stop() → void
 *     - Immediately halts any ongoing playback
 *     - Clears internal state
 *
 * Engines MUST NOT manage their own queue. Queuing is handled
 * exclusively by TTSController.
 */
export class BaseTTS {
  constructor() {
    /** @type {boolean} */
    this._stopped = false;
  }

  /** @returns {string} Unique engine identifier */
  get id() { throw new Error('BaseTTS.id not implemented'); }

  /** @returns {string} User-friendly display name */
  get name() { throw new Error('BaseTTS.name not implemented'); }

  /**
   * Optional one-time initialization (e.g. load voices, connect WS)
   * @returns {Promise<void>}
   */
  async init() {}

  /**
   * Speak a single text segment. No internal queuing.
   * @param {string} text - Text to speak
   * @param {number} rate - Speech rate (0.5 – 2.0)
   * @param {string} voice - Voice identifier
   * @returns {Promise<void>} Resolves when playback finishes
   */
  async speak(text, rate, voice) {
    throw new Error('BaseTTS.speak() not implemented');
  }

  /**
   * Immediately stop any ongoing playback and clean up resources.
   */
  stop() {
    throw new Error('BaseTTS.stop() not implemented');
  }
}
