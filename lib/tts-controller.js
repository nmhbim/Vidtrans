import { EdgeTTS } from './tts-engines/edge-tts.js';
import { NativeTTS } from './tts-engines/native-tts.js';

/**
 * TTSController — The SINGLE source of truth for TTS playback.
 *
 * Responsibilities:
 *   1. Queue management (enqueue, process sequentially, flush)
 *   2. Engine selection (edge / native)
 *   3. Playback lifecycle callbacks (for audio ducking)
 *   4. Rate & voice configuration
 *   5. Streaming pre-render cache: synthesize ahead → stream-play from cache
 *      (plays as soon as first chunk arrives, no need to wait for full audio)
 *
 * This is the ONLY place that calls engine.speak()/.synthesizeStream().
 * Nothing else in the codebase should call speak() directly.
 */
export class TTSController {
  /**
   * @param {Object} [options]
   * @param {Function} [options.onPlaybackStart] - Called when queue starts playing (was idle)
   * @param {Function} [options.onPlaybackEnd]   - Called when queue is empty and playback stops
   * @param {Function} [options.onError]         - Called on engine errors
   */
  constructor(options = {}) {
    /** @type {Object<string, import('./tts-engines/base-tts.js').BaseTTS>} */
    this._engines = {
      'edge': new EdgeTTS(),
      'native': new NativeTTS(),
    };

    /** @type {string[]} */
    this._queue = [];

    /** @type {boolean} */
    this._isPlaying = false;

    /** @type {string} */
    this._engineId = 'edge';

    /** @type {number} */
    this._rate = 1.0;

    /** @type {string} */
    this._voice = 'vi-VN-HoaiMyNeural';

    // Lifecycle callbacks
    this.onPlaybackStart = options.onPlaybackStart || null;
    this.onPlaybackEnd = options.onPlaybackEnd || null;
    this.onError = options.onError || null;

    // ── Streaming Pre-render Cache ────────────────────────────────────────
    //
    // Each entry is a StreamingAudioEntry:
    //   { chunks: Uint8Array[], state: 'rendering'|'done'|'error',
    //     onChunk, onDone }
    //
    // This allows playback to START as soon as the first chunk arrives,
    // even while more chunks are still being received from the WebSocket.
    //
    /** @type {Map<string, object>} text → StreamingAudioEntry */
    this._audioCache = new Map();

    /** @type {Set<string>} texts currently being synthesized */
    this._renderingInProgress = new Set();

    /** @type {HTMLAudioElement|null} currently playing pre-rendered audio */
    this._prerenderedAudio = null;

    /**
     * Abort callback: force-resolves the active _streamEntry() promise.
     * @type {Function|null}
     */
    this._streamAbort = null;

    /** @type {number} max items in cache to prevent memory bloat */
    this._maxCacheSize = 30;

    /** @type {string} text currently being spoken (for word boundary context) */
    this._currentText = '';
  }

  // ── Configuration ─────────────────────────────────────────────────────────

  /** @param {string} id - Engine identifier ('edge' | 'native') */
  setEngine(id) {
    if (this._engines[id]) {
      this._engineId = id;
    } else {
      console.warn(`[TTSController] Unknown engine: ${id}, keeping ${this._engineId}`);
    }
  }

  /** @param {number} rate */
  setRate(rate) { this._rate = rate; }

  /** @param {string} voice */
  setVoice(voice) { this._voice = voice; }

  /**
   * Set a listener for word boundary events (Edge TTS only).
   * @param {Function|null} fn - (wb, audio) => void
   */
  setWordBoundaryListener(fn) {
    const edge = this._engines['edge'];
    if (edge?.setWordBoundaryListener) {
      edge.setWordBoundaryListener(fn);
    }
  }

  /** @returns {string} Current engine id */
  get engineId() { return this._engineId; }

  /** @returns {string} Text currently being spoken */
  get currentText() { return this._currentText; }

  /** @returns {boolean} Whether currently playing */
  get isPlaying() { return this._isPlaying; }

  // ── Queue API ─────────────────────────────────────────────────────────────

  /**
   * Add text to the playback queue. Starts processing if idle.
   * @param {string} text
   */
  enqueue(text) {
    if (!text?.trim()) return;
    const trimmed = text.trim();

    // Prevent identical consecutive texts (e.g. if Whisper hallucinates)
    if (this._lastEnqueued === trimmed) return;
    this._lastEnqueued = trimmed;

    this._queue.push(trimmed);

    if (!this._isPlaying) {
      this._processQueue();
    }
  }

  /**
   * Stop all playback, clear queue, clean up ALL engines.
   * Force-resolves any pending promises so nothing hangs.
   */
  stop() {
    const wasPlaying = this._isPlaying;

    this._queue = [];
    this._isPlaying = false;

    // ⚡ Force-resolve the active _streamEntry promise FIRST
    if (this._streamAbort) {
      this._streamAbort();
      this._streamAbort = null;
    }

    // Stop ALL engines (not just current — ensure Edge TTS audio stops)
    for (const engine of Object.values(this._engines)) {
      try { engine.stop(); } catch (e) {}
    }

    // Stop any pre-rendered audio playback
    if (this._prerenderedAudio) {
      try {
        this._prerenderedAudio.pause();
        this._prerenderedAudio.removeAttribute('src');
        this._prerenderedAudio.load();
      } catch (e) {}
      this._prerenderedAudio = null;
    }

    if (wasPlaying) {
      this.onPlaybackEnd?.();
    }
  }

  // ── Pre-render API (Subtitle Mode) ────────────────────────────────────────

  /**
   * Start pre-rendering a single text. Returns immediately after kicking off
   * synthesis — does NOT wait for it to complete.
   * The entry is stored in cache and can be streamed during playback.
   *
   * @param {string} text
   * @returns {Promise<boolean>} true if synthesis was started or already cached
   */
  async prerender(text) {
    if (!text?.trim()) return false;
    const key = text.trim();

    // Already cached or in-progress
    if (this._audioCache.has(key) || this._renderingInProgress.has(key)) return true;

    // Only Edge TTS supports synthesizeStream()
    const engine = this._engines['edge'];
    if (!engine || typeof engine.synthesizeStream !== 'function') return false;

    this._renderingInProgress.add(key);

    try {
      // Evict oldest entries if cache is full
      this._evictCache();

      const entry = await engine.synthesizeStream(key, this._rate, this._voice);
      this._audioCache.set(key, entry);

      // When synthesis finishes, remove from in-progress set
      const originalOnDone = entry.onDone;
      entry.onDone = () => {
        this._renderingInProgress.delete(key);
        originalOnDone?.();
        log(`[TTSController] ✅ Cached: "${key.substring(0, 40)}..." (${entry.chunks.length} chunks, state=${entry.state})`);
      };

      // If already done by the time we get here (very short text)
      if (entry.state === 'done' || entry.state === 'error') {
        this._renderingInProgress.delete(key);
      }

      return true;
    } catch (err) {
      console.error(`[TTSController] ❌ Pre-render failed: "${key.substring(0, 30)}..."`, err.message);
      this._renderingInProgress.delete(key);
      return false;
    }
  }

  /**
   * Pre-render multiple texts. Each synthesis is kicked off and the function
   * returns once all have been STARTED (not necessarily completed).
   * @param {string[]} texts
   * @returns {Promise<number>} Number of items started or already cached
   */
  async prerenderBatch(texts) {
    let count = 0;
    for (const text of texts) {
      if (!text?.trim()) continue;
      const ok = await this.prerender(text);
      if (ok) count++;
    }
    log(`[TTSController] 📦 Batch: ${count}/${texts.length} started/cached`);
    return count;
  }

  /**
   * Play pre-rendered audio for text using MediaSource streaming.
   * Starts playback as soon as the FIRST chunk is available — does NOT
   * wait for the full audio to be synthesized.
   *
   * If not cached at all → falls back to live speak() (also streaming).
   *
   * @param {string} text
   * @returns {Promise<void>} Resolves when playback finishes
   */
  async playPrerendered(text) {
    if (!text?.trim()) return;
    const key = text.trim();

    // Deduplicate
    if (this._lastEnqueued === key) return;
    this._lastEnqueued = key;

    const entry = this._audioCache.get(key);

    if (entry && (entry.chunks.length > 0 || entry.state === 'rendering')) {
      // ⚡ Stream from cache — play chunks as they arrive
      const chunkCount = entry.chunks.length;
      const isDone = entry.state === 'done';
      log(`[TTSController] ⚡ Cache HIT: "${key.substring(0, 40)}..." (${chunkCount} chunks, ${isDone ? 'complete' : 'still rendering'})`);

      this._isPlaying = true;
      this.onPlaybackStart?.();

      try {
        await this._streamEntry(entry);
      } catch (err) {
        console.error('[TTSController] ❌ streamEntry error:', err.message);
      }

      this._isPlaying = false;
      this.onPlaybackEnd?.();
    } else {
      // Cache MISS — fall back to live synthesis (speak() also streams)
      log(`[TTSController] 🐌 Cache MISS: "${key.substring(0, 40)}..." — live synthesis`);
      this.enqueue(key);
    }
  }

  /**
   * Check if text is already pre-rendered (or being rendered) in cache.
   * @param {string} text
   * @returns {boolean}
   */
  isCached(text) {
    return text ? this._audioCache.has(text.trim()) : false;
  }

  /**
   * Get cache stats for debugging.
   * @returns {{ size: number, rendering: number }}
   */
  getCacheStats() {
    return {
      size: this._audioCache.size,
      rendering: this._renderingInProgress.size,
    };
  }

  /**
   * Clear all cached audio and abort in-progress renders.
   */
  clearCache() {
    this._audioCache.clear();
    this._renderingInProgress.clear();
    log('[TTSController] 🗑️ Cache cleared');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Process queue items sequentially.
   * Fires onPlaybackStart when transitioning from idle → playing.
   * Fires onPlaybackEnd when queue is exhausted.
   */
  async _processQueue() {
    if (this._queue.length === 0) {
      const wasPlaying = this._isPlaying;
      this._isPlaying = false;
      if (wasPlaying) {
        this.onPlaybackEnd?.();
      }
      return;
    }

    // Signal start of playback sequence
    if (!this._isPlaying) {
      this._isPlaying = true;
      this.onPlaybackStart?.();
    }

    const text = this._queue.shift();
    const engine = this._engines[this._engineId];

    if (!engine) {
      console.error(`[TTSController] Engine "${this._engineId}" not found`);
      this._processQueue();
      return;
    }

    try {
      this._currentText = text;
      log(`[TTSController] 🔊 Playing (${engine.name}): "${text.substring(0, 40)}..."`);
      await engine.speak(text, this._rate, this._voice);
    } catch (err) {
      const errMsg = err?.message || 'Unknown TTS error';
      console.error(`[TTSController] ❌ ${engine.id} error:`, errMsg);
      this.onError?.(errMsg);
    }

    this._currentText = '';

    // Continue to next item (if not stopped)
    if (this._isPlaying) {
      this._processQueue();
    }
  }

  /**
   * Stream-play a cached entry via MediaSource.
   * Feeds existing chunks immediately, then appends new ones as they arrive.
   * Resolves when audio.onended fires or when stop() force-aborts.
   *
   * @param {object} entry - StreamingAudioEntry { chunks, state, onChunk, onDone }
   * @returns {Promise<void>}
   */
  _streamEntry(entry) {
    return new Promise((resolve) => {
      const audio = new Audio();
      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);
      audio.src = objectUrl;
      this._prerenderedAudio = audio;

      let resolved = false;

      const cleanup = () => {
        URL.revokeObjectURL(objectUrl);
        if (this._prerenderedAudio === audio) this._prerenderedAudio = null;
      };

      const safeResolve = () => {
        if (resolved) return;
        resolved = true;
        this._streamAbort = null;
        cleanup();
        resolve();
      };

      // ⚡ Store abort callback — stop() calls this to force-end immediately
      this._streamAbort = () => {
        audio.pause();
        audio.removeAttribute('src');
        try { audio.load(); } catch (e) {}
        safeResolve();
      };

      mediaSource.onsourceopen = () => {
        let sourceBuffer;
        try {
          sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
        } catch (e) {
          console.error('[TTSController] addSourceBuffer failed:', e);
          safeResolve();
          return;
        }

        let nextChunkIndex = 0;
        let isAppending = false;
        let wsDone = entry.state === 'done' || entry.state === 'error';
        let hasStartedPlaying = false;

        const appendNext = () => {
          if (resolved) return; // Already aborted
          if (isAppending || !sourceBuffer || sourceBuffer.updating) return;
          if (nextChunkIndex < entry.chunks.length) {
            isAppending = true;
            try {
              sourceBuffer.appendBuffer(entry.chunks[nextChunkIndex++]);
            } catch (e) {
              isAppending = false;
              console.error('[TTSController] appendBuffer error:', e);
            }
          } else if (wsDone && mediaSource.readyState === 'open') {
            try { mediaSource.endOfStream(); } catch (e) {}
          }
        };

        sourceBuffer.onupdateend = () => {
          isAppending = false;

          // Start playback on first appended chunk
          if (!hasStartedPlaying && nextChunkIndex > 0) {
            hasStartedPlaying = true;
            audio.play().catch(() => {
              safeResolve();
            });
          }

          appendNext();
        };

        // Hook into the entry's live stream for new chunks
        const prevOnChunk = entry.onChunk;
        entry.onChunk = (data) => {
          prevOnChunk?.(data);
          if (!resolved) appendNext();
        };

        const prevOnDone = entry.onDone;
        entry.onDone = () => {
          prevOnDone?.();
          wsDone = true;
          if (!resolved) appendNext();
        };

        // Feed all already-buffered chunks
        appendNext();
      };

      audio.onended = () => { safeResolve(); };
      audio.onerror = () => { safeResolve(); };
    });
  }

  /**
   * Evict oldest cache entries when exceeding max size.
   */
  _evictCache() {
    while (this._audioCache.size >= this._maxCacheSize) {
      const oldestKey = this._audioCache.keys().next().value;
      this._audioCache.delete(oldestKey);
      log(`[TTSController] 🗑️ Evicted: "${oldestKey?.substring(0, 30)}..."`);
    }
  }
}
