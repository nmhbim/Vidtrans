/**
 * base-tts.ts
 * Abstract base class for all TTS engines.
 */
export class BaseTTS {
    rate = 1.0;
    voice = '';
    onWordBoundary = null;
    constructor() { }
    setRate(rate) {
        this.rate = rate;
    }
    setVoice(voice) {
        this.voice = voice;
    }
    setWordBoundaryListener(listener) {
        this.onWordBoundary = listener;
    }
}
