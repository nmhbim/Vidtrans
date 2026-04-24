import { BaseTTS } from './base-tts';

/**
 * EdgeTTS — Uses Microsoft Edge Read Aloud API via WebSocket.
 */
export class EdgeTTS extends BaseTTS {
  private ws: WebSocket | null = null;
  private audio: HTMLAudioElement | null = null;
  private connectionPromise: Promise<void> | null = null;

  constructor() {
    super();
    this.audio = new Audio();
  }

  async speak(text: string): Promise<void> {
    console.log(`[EdgeTTS] Speaking: ${text}`);
    // WebSocket communication logic...
    return Promise.resolve();
  }

  stop() {
    if (this.ws) this.ws.close();
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
    }
  }

  pause() {
    if (this.audio) this.audio.pause();
  }

  resume() {
    if (this.audio) this.audio.play();
  }
}
