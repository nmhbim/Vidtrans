export class BaseTTS {
  constructor() {
    this.onStart = null; // Callback when audio starts playing
    this.onEnd = null;   // Callback when all audio finishes
  }

  /**
   * Return a unique identifier for this engine
   */
  get id() { return 'base'; }

  /**
   * Return a user-friendly name for this engine
   */
  get name() { return 'Base TTS'; }

  /**
   * Initialize the engine (e.g., fetch tokens, connect to services)
   */
  async init() {}

  /**
   * Speak the given text
   * @param {string} text 
   * @param {number} rate 
   * @param {string} voice 
   * @returns {Promise<void>} Resolves when audio playback has finished entirely
   */
  async speak(text, rate, voice) {
    throw new Error('Not implemented');
  }

  /**
   * Immediately halt any ongoing playback
   */
  stop() {
    throw new Error('Not implemented');
  }
}

