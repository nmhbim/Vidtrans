import { BaseTTS } from './base-tts.js';

/**
 * NativeTTS — Browser SpeechSynthesis API.
 *
 * Follows BaseTTS contract:
 *   speak() plays ONE text via SpeechSynthesisUtterance, resolves when done.
 *   No internal queue.
 */
export class NativeTTS extends BaseTTS {
  constructor() {
    super();
    /** @type {SpeechSynthesisUtterance|null} */
    this._currentUtterance = null;
    this._stopped = false;
  }

  get id() { return 'native'; }
  get name() { return 'Trình duyệt (Native)'; }

  /**
   * Ensure browser voices are loaded.
   * @returns {Promise<void>}
   */
  async init() {
    return new Promise((resolve) => {
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        resolve();
      } else {
        speechSynthesis.onvoiceschanged = () => resolve();
        setTimeout(resolve, 2000); // Fallback timeout
      }
    });
  }

  /**
   * Speak one text segment using browser SpeechSynthesis.
   * @param {string} text
   * @param {number} rate
   * @param {string} voiceName - Voice URI or name
   * @returns {Promise<void>} Resolves when speech finishes
   */
  async speak(text, rate, voiceName) {
    this._stopped = false;
    await this.init();

    // Chrome bug: cancel() then immediate speak() drops the utterance.
    // A small delay after cancel is required.
    this.stop();

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (this._stopped) { resolve(); return; }

        const utt = new SpeechSynthesisUtterance(text);

        // Find the requested voice
        const voices = speechSynthesis.getVoices();
        const voiceObj = voices.find(v => v.voiceURI === voiceName || v.name === voiceName);
        if (voiceObj) {
          utt.voice = voiceObj;
        } else {
          utt.lang = 'vi-VN';
        }

        utt.rate = rate;

        utt.onend = () => {
          this._currentUtterance = null;
          resolve();
        };

        utt.onerror = (e) => {
          this._currentUtterance = null;
          // 'interrupted' = normal stop(), not a real error
          if (e.error === 'interrupted' || e.error === 'canceled') {
            resolve();
          } else {
            reject(new Error(`NativeTTS error: ${e.error}`));
          }
        };

        this._currentUtterance = utt;
        speechSynthesis.speak(utt);
      }, 50);
    });
  }

  /**
   * Immediately stop any ongoing speech.
   */
  stop() {
    this._stopped = true;
    if (this._currentUtterance || speechSynthesis.speaking) {
      speechSynthesis.cancel();
      this._currentUtterance = null;
    }
  }
}
