/**
 * TTSBridge — Bridges between the content script and background TTS engine.
 */
export class TTSBridge {
  constructor() {}

  speak(text: string) {
    chrome.runtime.sendMessage({ type: 'SPEAK_SUBTITLE', text });
  }

  pause() {
    chrome.runtime.sendMessage({ type: 'PAUSE_TTS' });
  }

  resume() {
    chrome.runtime.sendMessage({ type: 'RESUME_TTS' });
  }

  stop() {
    chrome.runtime.sendMessage({ type: 'STOP_TRANSLATION' });
  }
}
