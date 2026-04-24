import { BaseTTS } from './base-tts';
/**
 * NativeTTS — Uses browser's SpeechSynthesis API.
 */
export class NativeTTS extends BaseTTS {
    constructor() {
        super();
    }
    async speak(text) {
        return new Promise((resolve, reject) => {
            speechSynthesis.cancel();
            const utt = new SpeechSynthesisUtterance(text);
            const voices = speechSynthesis.getVoices();
            const voiceObj = voices.find(v => v.voiceURI === this.voice || v.name === this.voice);
            if (voiceObj)
                utt.voice = voiceObj;
            utt.rate = this.rate;
            utt.onstart = () => {
                // Start playback
            };
            utt.onend = () => resolve();
            utt.onerror = (e) => reject(e);
            utt.onboundary = (event) => {
                if (event.name === 'word' && this.onWordBoundary) {
                    this.onWordBoundary({
                        text: text.substring(event.charIndex, event.charIndex + (event.charLength || 1)),
                        offsetMs: 0, // Native doesn't give accurate audio offset easily
                        durationMs: 0,
                        textOffset: event.charIndex,
                        textLength: event.charLength || 0
                    });
                }
            };
            speechSynthesis.speak(utt);
        });
    }
    stop() {
        speechSynthesis.cancel();
    }
    pause() {
        speechSynthesis.pause();
    }
    resume() {
        speechSynthesis.resume();
    }
}
