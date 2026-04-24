/**
 * base-tts.ts
 * Abstract base class for all TTS engines.
 */

export interface WordBoundary {
  text: string;
  offsetMs: number;
  durationMs: number;
  textOffset: number;
  textLength: number;
}

export abstract class BaseTTS {
  protected rate: number = 1.0;
  protected voice: string = '';
  protected onWordBoundary: ((wb: WordBoundary) => void) | null = null;

  constructor() {}

  setRate(rate: number) {
    this.rate = rate;
  }

  setVoice(voice: string) {
    this.voice = voice;
  }

  setWordBoundaryListener(listener: (wb: WordBoundary) => void) {
    this.onWordBoundary = listener;
  }

  abstract speak(text: string): Promise<void>;
  abstract stop(): void;
  abstract pause(): void;
  abstract resume(): void;
}
