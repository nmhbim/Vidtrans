/**
 * status.ts
 * Manages the status bar and transcript display in the UI.
 */
import { escapeHtml } from '../lib/utils';

export type StatusType = 'idle' | 'active' | 'error' | 'warning';

export class StatusManager {
  constructor(
    private statusDot: HTMLElement,
    private statusText: HTMLElement,
    private transcriptBox: HTMLElement
  ) {}

  setStatus(text: string, type: StatusType = 'idle') {
    this.statusText.textContent = text;
    this.statusDot.className = 'status-dot';
    if (type === 'active') this.statusDot.classList.add('active');
    else if (type === 'error') this.statusDot.classList.add('error');
    else if (type === 'warning') this.statusDot.classList.add('warning');
  }

  addTranscript(original: string, translated: string) {
    // Clear placeholder if it exists
    if (this.transcriptBox.querySelector('span[style*="italic"]')) {
      this.transcriptBox.innerHTML = '';
    }

    const item = document.createElement('div');
    item.className = 'transcript-item';
    item.innerHTML = `
      <span class="transcript-vi">${escapeHtml(translated)}</span>
      <span class="transcript-en">${escapeHtml(original)}</span>
    `;

    this.transcriptBox.appendChild(item);
    this.transcriptBox.scrollTop = this.transcriptBox.scrollHeight;
  }

  addStatusMessage(message: string, isError = false) {
    const item = document.createElement('div');
    item.className = 'transcript-item';
    item.style.color = isError ? '#ef4444' : '#10b981';
    item.style.fontSize = '12px';
    item.textContent = message;

    this.transcriptBox.appendChild(item);
    this.transcriptBox.scrollTop = this.transcriptBox.scrollHeight;
  }
}
