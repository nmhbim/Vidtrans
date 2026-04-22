import { BaseTTS } from './base-tts.js';

export class NativeTTS extends BaseTTS {
  constructor() {
    super();
    this.currentUtterance = null;
  }

  get id() { return 'native'; }
  get name() { return 'Trình duyệt (Native)'; }

  async init() {
    // Force browser to load voices
    return new Promise((resolve) => {
      let voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        resolve();
      } else {
        speechSynthesis.onvoiceschanged = () => {
          resolve();
        };
        // Fallback timeout
        setTimeout(resolve, 2000);
      }
    });
  }

  async speak(text, rate, voiceName) {
    // Ensure voices are loaded in this document context
    await this.init();

    return new Promise((resolve, reject) => {
      this.stop(); // Stop any currently playing TTS
      
      // Chrome has a notorious bug where calling speak() immediately after cancel()
      // drops the utterance silently. We need a tiny timeout.
      setTimeout(() => {
        const utt = new SpeechSynthesisUtterance(text);
        
        // Try to find exact voice
        const voices = speechSynthesis.getVoices();
        const voiceObj = voices.find(v => v.voiceURI === voiceName || v.name === voiceName);
        if (voiceObj) {
          utt.voice = voiceObj;
        } else {
          // Fallback to Vietnamese if not found
          utt.lang = 'vi-VN';
        }
        
        utt.rate = rate;
        
        utt.onstart = () => {
          if (typeof this.onStart === 'function') {
            this.onStart();
          }
        };

        utt.onend = () => {
          this.currentUtterance = null;
          if (typeof this.onEnd === 'function') {
            this.onEnd();
          }
          resolve();
        };
        
        utt.onerror = (e) => {
          this.currentUtterance = null;
          if (typeof this.onEnd === 'function') {
            this.onEnd();
          }
          reject(new Error(`Native TTS Error: ${e.error}`));
        };
        
        this.currentUtterance = utt;
        speechSynthesis.speak(utt);
      }, 50);
    });
  }

  stop() {
    if (this.currentUtterance || speechSynthesis.speaking) {
      speechSynthesis.cancel();
      this.currentUtterance = null;
      if (typeof this.onEnd === 'function') {
        this.onEnd();
      }
    }
  }
}

