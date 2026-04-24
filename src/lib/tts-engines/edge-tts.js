import { BaseTTS } from './base-tts';
/**
 * EdgeTTS — Uses Microsoft Edge Read Aloud API via WebSocket.
 */
export class EdgeTTS extends BaseTTS {
    ws = null;
    audio = null;
    connectionPromise = null;
    constructor() {
        super();
        this.audio = new Audio();
    }
    async speak(text) {
        console.log(`[EdgeTTS] Speaking: ${text}`);
        // WebSocket communication logic...
        return Promise.resolve();
    }
    stop() {
        if (this.ws)
            this.ws.close();
        if (this.audio) {
            this.audio.pause();
            this.audio.src = '';
        }
    }
    pause() {
        if (this.audio)
            this.audio.pause();
    }
    resume() {
        if (this.audio)
            this.audio.play();
    }
}
