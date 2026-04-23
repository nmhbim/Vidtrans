import { BaseTTS } from './base-tts.js';

/**
 * EdgeTTS — Microsoft Edge Text-to-Speech via WebSocket streaming.
 *
 * Follows BaseTTS contract:
 *   speak() synthesizes + plays ONE text, resolves when audio finishes.
 *   No internal queue — TTSController handles queuing.
 */
export class EdgeTTS extends BaseTTS {
  constructor() {
    super();
    /** @type {WebSocket|null} */
    this._ws = null;
    /** @type {HTMLAudioElement|null} */
    this._currentAudio = null;
    /** @type {string|null} */
    this._currentObjectUrl = null;
    /** @type {Object<string, {onData: Function, onEnd: Function, onWordBoundary?: Function}>} */
    this._activeRequests = {};
    /** @type {boolean} */
    this._stopped = false;
    /**
     * Abort callback: force-resolves the active speak() promise.
     * Set inside speak(), called by stop().
     * @type {Function|null}
     */
    this._abortResolve = null;

    /**
     * External word boundary listener.
     * Called with (wordBoundary, audioElement) during speak().
     * @type {Function|null}
     */
    this._onWordBoundary = null;
  }

  get id() { return 'edge'; }
  get name() { return 'Microsoft Edge (Online)'; }

  /**
   * Set a listener for word boundary events during playback.
   * @param {Function|null} fn - (wb: {offsetMs, durationMs, text, textOffset, textLength, boundaryType}, audio: HTMLAudioElement) => void
   */
  setWordBoundaryListener(fn) {
    this._onWordBoundary = fn;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Synthesize and play one text segment via Edge TTS WebSocket.
   * @param {string} text
   * @param {number} rate
   * @param {string} voiceName
   * @returns {Promise<void>} Resolves when audio playback finishes
   */
  async speak(text, rate, voiceName) {
    this._stopped = false;
    this._abortResolve = null;

    const normalizedText = text.replace(/\.\.+/g, '.').replace(/\. /g, ', ').trim();
    if (!normalizedText) return;

    const ws = await this._connect();
    if (this._stopped) return;

    const requestId = this._generateId().toUpperCase();

    const audio = new Audio();
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    audio.src = objectUrl;

    this._currentAudio = audio;
    this._currentObjectUrl = objectUrl;

    return new Promise((resolve, reject) => {
      let sourceBuffer = null;
      let chunks = [];
      let isAppending = false;
      let isWsDone = false;
      let hasStartedPlaying = false;
      let resolved = false;

      const safeResolve = () => {
        if (resolved) return;
        resolved = true;
        this._abortResolve = null;
        cleanup();
        resolve();
      };

      // ⚡ Store abort callback — stop() calls this to force-end immediately
      this._abortResolve = safeResolve;

      const cleanup = () => {
        delete this._activeRequests[requestId];
        if (this._currentAudio === audio) {
          this._currentAudio = null;
          this._currentObjectUrl = null;
        }
      };

      const appendNext = () => {
        if (chunks.length > 0 && !isAppending && sourceBuffer && !sourceBuffer.updating) {
          isAppending = true;
          sourceBuffer.appendBuffer(chunks.shift());
        }
      };

      // Register handlers for this request (onWordBoundary is optional)
      this._activeRequests[requestId] = {
        fullText: normalizedText,
        currentTextOffset: 0,
        onData: (data) => {
          if (resolved) return; // Already aborted
          chunks.push(data);
          appendNext();

          // Start playback on first chunk for low latency
          if (!hasStartedPlaying) {
            hasStartedPlaying = true;
            console.log(`[EdgeTTS] ⚡ First chunk received: ${requestId}`);
            audio.play().catch((err) => {
              console.error('[EdgeTTS] Play error:', err);
              safeResolve();
            });
          }
        },
        onEnd: () => {
          isWsDone = true;
          if (sourceBuffer && !sourceBuffer.updating && chunks.length === 0) {
            try { mediaSource.endOfStream(); } catch (e) {}
          }
        },
        onWordBoundary: (wb) => {
          // Forward to external listener if set
          this._onWordBoundary?.(wb, audio);
        }
      };

      // Audio lifecycle
      audio.onended = () => {
        URL.revokeObjectURL(objectUrl);
        safeResolve();
      };

      audio.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        safeResolve();
      };

      // MediaSource setup
      mediaSource.onsourceopen = () => {
        sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');

        sourceBuffer.onupdateend = () => {
          isAppending = false;
          appendNext();
          if (isWsDone && chunks.length === 0) {
            try { mediaSource.endOfStream(); } catch (e) {}
          }
        };

        // Build and send SSML
        const prosodyRate = Math.round((rate - 1.0) * 100);
        const rateStr = prosodyRate >= 0 ? `+${prosodyRate}%` : `${prosodyRate}%`;
        const voice = voiceName || 'vi-VN-HoaiMyNeural';
        const escapedText = normalizedText
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="vi-VN"><voice name="${voice}"><prosody rate="${rateStr}">${escapedText}</prosody></voice></speak>`;

        const timestamp = Date.now();
        const ssmlMsg = `X-RequestId: ${requestId}\r\n` +
          `Content-Type: application/ssml+xml\r\n` +
          `X-Timestamp: ${timestamp}\r\n` +
          `Path: ssml\r\n\r\n` +
          ssml;

        ws.send(ssmlMsg);
      };

      // Safety timeout — 15s without any audio data
      setTimeout(() => {
        if (!hasStartedPlaying && !this._stopped && !resolved) {
          safeResolve();
          reject(new Error(`EdgeTTS timeout: no audio received (${requestId})`));
        }
      }, 15000);
    });
  }

  /**
   * Immediately stop playback and clean up.
   * Force-resolves the active speak() promise so the queue doesn't hang.
   */
  stop() {
    this._stopped = true;

    // ⚡ Force-resolve the active speak() promise FIRST
    if (this._abortResolve) {
      this._abortResolve();
      this._abortResolve = null;
    }

    // Stop current audio
    if (this._currentAudio) {
      this._currentAudio.pause();
      this._currentAudio.removeAttribute('src');
      this._currentAudio.load(); // Force release
    }
    if (this._currentObjectUrl) {
      URL.revokeObjectURL(this._currentObjectUrl);
    }
    this._currentAudio = null;
    this._currentObjectUrl = null;

    for (const id of Object.keys(this._activeRequests)) {
      delete this._activeRequests[id];
    }
  }

  pause() {
    if (this._currentAudio && !this._currentAudio.paused) {
      this._currentAudio.pause();
    }
  }

  resume() {
    if (this._currentAudio && this._currentAudio.paused) {
      this._currentAudio.play().catch(() => {});
    }
  }

  // ── Pre-render API ───────────────────────────────────────────────────────

  /**
   * Start synthesizing text and return a StreamingAudioEntry immediately.
   * The entry accumulates audio chunks in real-time and can be played
   * before synthesis completes (streaming playback).
   *
   * @param {string} text
   * @param {number} rate
   * @param {string} voiceName
   * @returns {Promise<{chunks: Uint8Array[], state: string, onChunk: Function|null, onDone: Function|null}>}
   *   Entry object with:
   *   - chunks: Array of audio data chunks received so far
   *   - state: 'rendering' | 'done' | 'error'
   *   - onChunk: callback set by consumer, called when new chunk arrives
   *   - onDone: callback set by consumer, called when synthesis finishes
   */
  async synthesizeStream(text, rate, voiceName) {
    this._stopped = false;

    const normalizedText = text.replace(/\.\.+/g, '.').replace(/\. /g, ', ').trim();
    const entry = {
      chunks: [],
      state: normalizedText ? 'rendering' : 'done',
      onChunk: null,
      onDone: null,
    };

    if (!normalizedText) return entry;

    const ws = await this._connect();
    if (this._stopped) { entry.state = 'done'; return entry; }

    const requestId = this._generateId().toUpperCase();

    this._activeRequests[requestId] = {
      fullText: normalizedText,
      currentTextOffset: 0,
      onData: (data) => {
        entry.chunks.push(data);
        // Notify consumer that a new chunk is available
        entry.onChunk?.(data);
      },
      onEnd: () => {
        delete this._activeRequests[requestId];
        entry.state = 'done';
        console.log(`[EdgeTTS] 📦 Synthesis complete: ${requestId} (${entry.chunks.length} chunks)`);
        entry.onDone?.();
      },
      onWordBoundary: (wb) => {
        // Store word boundaries in entry for later playback sync
        if (!entry.wordBoundaries) entry.wordBoundaries = [];
        entry.wordBoundaries.push(wb);
        entry.onWordBoundary?.(wb);
      }
    };

    // Build and send SSML
    const prosodyRate = Math.round((rate - 1.0) * 100);
    const rateStr = prosodyRate >= 0 ? `+${prosodyRate}%` : `${prosodyRate}%`;
    const voice = voiceName || 'vi-VN-HoaiMyNeural';
    const escapedText = normalizedText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="vi-VN"><voice name="${voice}"><prosody rate="${rateStr}">${escapedText}</prosody></voice></speak>`;

    const timestamp = Date.now();
    const ssmlMsg = `X-RequestId: ${requestId}\r\n` +
      `Content-Type: application/ssml+xml\r\n` +
      `X-Timestamp: ${timestamp}\r\n` +
      `Path: ssml\r\n\r\n` +
      ssml;

    ws.send(ssmlMsg);

    // Safety timeout
    setTimeout(() => {
      if (this._activeRequests[requestId]) {
        delete this._activeRequests[requestId];
        entry.state = 'error';
        entry.onDone?.();
      }
    }, 15000);

    return entry;
  }

  // ── WebSocket Management ─────────────────────────────────────────────────

  async _connect() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return this._ws;

    // Close stale connection
    if (this._ws) {
      try { this._ws.close(); } catch (e) {}
      this._ws = null;
    }

    const token = await this._getSecMsGec();
    const connId = this._generateId();
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${connId}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=1-143.0.3650.75`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        const configMsg = `X-Timestamp: ${Date.now()}\r\n` +
          `Content-Type: application/json; charset=utf-8\r\n` +
          `Path: speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
        ws.send(configMsg);
        this._ws = ws;
        resolve(ws);
      };

      ws.onerror = () => reject(new Error('EdgeTTS WebSocket connection failed'));

      ws.onmessage = (e) => this._handleWsMessage(e);

      ws.onclose = () => {
        if (this._ws === ws) this._ws = null;
      };
    });
  }

  /**
   * Route incoming WS messages to the correct request handler.
   */
  _handleWsMessage(event) {
    if (typeof event.data === 'string') {
      const reqId = this._extractRequestId(event.data);
      if (!reqId || !this._activeRequests[reqId]) return;

      if (event.data.includes('Path:turn.end')) {
        this._activeRequests[reqId].onEnd();
      } else if (event.data.includes('Path:audio.metadata')) {
        // Parse word boundary metadata
        try {
          const jsonStart = event.data.indexOf('{');
          if (jsonStart !== -1) {
            const meta = JSON.parse(event.data.substring(jsonStart));
            const items = meta.Metadata || [];
            for (const item of items) {
              if (item.Type === 'WordBoundary' && item.Data) {
                // Debug log to verify WordBoundary structure
                console.log("[EdgeTTS] 🔤 WordBoundary raw:", JSON.stringify(item));

                const req = this._activeRequests[reqId];
                // Handle both nested and flat structures
                const word = item.Data.text?.Text || item.Data.Text || '';
                let textOffset = item.Data.text?.Offset ?? item.Data.Offset_Text ?? item.Data.TextOffset;

                // Fallback tracking: Find the word in the original text to get the real character offset
                if (req && req.fullText && word) {
                  // Search for the word starting from the current offset
                  const idx = req.fullText.indexOf(word, req.currentTextOffset);
                  if (idx !== -1) {
                    textOffset = idx;
                    req.currentTextOffset = idx + word.length;
                  } else {
                    // Fallback if exactly matching the word fails (e.g. punctuation stripped)
                    textOffset = req.currentTextOffset;
                  }
                } else if (textOffset === undefined) {
                  textOffset = 0;
                }

                const wb = {
                  // Offset from audio start in ms (server sends 100ns ticks)
                  offsetMs: item.Data.Offset / 10000,
                  durationMs: item.Data.Duration / 10000,
                  text: word,
                  textOffset: textOffset,
                  textLength: item.Data.text?.Length ?? item.Data.Length ?? 0,
                  boundaryType: item.Data.text?.BoundaryType || item.Data.BoundaryType || 'Word',
                };
                req.onWordBoundary?.(wb);
              }
            }
          }
        } catch (e) {
          // Metadata parse error — non-critical, skip
        }
      }
    } else {
      // Binary audio data
      const data = new Uint8Array(event.data);
      const headerLength = new DataView(data.buffer).getUint16(0);
      const headerStr = new TextDecoder().decode(data.slice(2, 2 + headerLength));
      const reqId = this._extractRequestId(headerStr);

      if (reqId && this._activeRequests[reqId] && headerStr.includes('Path:audio')) {
        this._activeRequests[reqId].onData(data.slice(headerLength + 2));
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  async _getSecMsGec() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_EDGE_TOKEN' }, (response) => {
        resolve(response?.token || '');
      });
    });
  }

  _generateId() {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16).toLowerCase();
    });
  }

  _extractRequestId(headerStr) {
    const match = headerStr.match(/X-RequestId:\s*([a-f0-9]+)/i);
    return match ? match[1].toUpperCase() : null;
  }
}
