/**
 * SubtitleSync — timestamp-based subtitle display synced to video.currentTime
 *
 * Design principles:
 * - Translation is EXTERNAL: caller pre-translates all events before calling start()
 * - Binary search O(log n) per frame for fast lookup
 * - requestAnimationFrame for smooth 60fps sync
 * - Each event has: { start, duration, text, translated? }
 *   - If translated exists → show translated (+ original as secondary)
 *   - If no translated → show text as-is
 *
 * Pre-rendering (Subtitle Mode):
 * - Looks ahead N events and calls onPrerender() to queue synthesis
 * - Tracks which events have been pre-rendered via prerenderedSet
 * - Calls onPlayPrerendered() instead of onShow() for cache-hit playback
 */
class SubtitleSync {
  constructor() {
    /** @type {Array<{start: number, duration: number, text: string, translated?: string}>} */
    this.events = [];
    this.rafId = null;
    this.lastText = null;

    // Pre-render tracking
    /** @type {Set<number>} indices of events that were sent for pre-rendering */
    this._prerenderRequested = new Set();
    /** @type {number} last index used for lookahead */
    this._lastLookaheadIndex = -1;
  }

  /**
   * Load subtitle events. Events must have { start, duration, text, translated? }.
   * @param {Array} events
   */
  load(events) {
    this.events = [...events].sort((a, b) => a.start - b.start);
    this.lastText = null;
    this._prerenderRequested.clear();
    this._lastLookaheadIndex = -1;
    console.log(`[SubtitleSync] Loaded ${this.events.length} events`);
  }

  /**
   * Binary search: find the event active at currentTimeMs.
   * @param {number} currentTimeMs
   * @returns {object|null}
   */
  _findEvent(currentTimeMs) {
    const events = this.events;
    if (!events.length) return null;

    let lo = 0, hi = events.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = events[mid];

      if (currentTimeMs < e.start) {
        hi = mid - 1;
      } else if (currentTimeMs > e.start + e.duration) {
        lo = mid + 1;
      } else {
        return e;
      }
    }

    return null;
  }

  /**
   * Find the index of the event active at currentTimeMs.
   * @param {number} currentTimeMs
   * @returns {number} -1 if not found
   */
  _findEventIndex(currentTimeMs) {
    const events = this.events;
    if (!events.length) return -1;

    let lo = 0, hi = events.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = events[mid];

      if (currentTimeMs < e.start) {
        hi = mid - 1;
      } else if (currentTimeMs > e.start + e.duration) {
        lo = mid + 1;
      } else {
        return mid;
      }
    }

    return -1;
  }

  /**
   * Start the rAF sync loop.
   * @param {HTMLVideoElement} video
   * @param {Function} onShow - (displayText: string, originalText: string) => void
   * @param {Function} onHide - () => void
   * @param {Object} [prerenderOptions] - Pre-rendering configuration
   * @param {Function} [prerenderOptions.onPrerender] - (texts: string[]) => void — called with upcoming texts to pre-render
   * @param {Function} [prerenderOptions.onPlayPrerendered] - (text: string) => void — play from cache
   * @param {number}   [prerenderOptions.lookahead=5] - Number of events to pre-render ahead
   */
  start(video, onShow, onHide, prerenderOptions = {}) {
    this.stop();

    const {
      onPrerender = null,
      onPlayPrerendered = null,
      lookahead = 5,
    } = prerenderOptions;

    const tick = () => {
      if (!video || video.paused || video.ended) {
        this.rafId = requestAnimationFrame(tick);
        return;
      }

      const currentMs = video.currentTime * 1000;
      // Lead time compensates for TTS network latency.
      // Higher for Edge TTS (needs time to stream first chunk from WebSocket).
      // Lower for Native TTS (local synthesis, near zero latency).
      const leadTimeMs = onPlayPrerendered ? 800 : 350;
      
      const currentIndex = this._findEventIndex(currentMs + leadTimeMs);

      // ── Pre-render lookahead ──────────────────────────────────────────
      if (onPrerender && currentIndex !== -1 && currentIndex !== this._lastLookaheadIndex) {
        this._lastLookaheadIndex = currentIndex;
        const textsToPrerender = [];

        for (let i = currentIndex + 1; i <= currentIndex + lookahead && i < this.events.length; i++) {
          if (!this._prerenderRequested.has(i)) {
            const evt = this.events[i];
            const displayText = evt.translated || evt.text;
            if (displayText?.trim()) {
              textsToPrerender.push(displayText);
              this._prerenderRequested.add(i);
            }
          }
        }

        if (textsToPrerender.length > 0) {
          onPrerender(textsToPrerender);
        }
      }

      // ── Current event display ─────────────────────────────────────────
      const event = currentIndex !== -1 ? this.events[currentIndex] : null;

      if (!event) {
        if (this.lastText !== null) {
          this.lastText = null;
          onHide?.();
        }
        this.rafId = requestAnimationFrame(tick);
        return;
      }

      // Use translated text if available, otherwise raw text
      const displayText = event.translated || event.text;

      if (displayText === this.lastText) {
        this.rafId = requestAnimationFrame(tick);
        return;
      }

      this.lastText = displayText;
      // If translated exists, show it as primary; original as secondary
      // If no translated (native lang), show text as primary, no secondary
      onShow?.(displayText, event.translated ? event.text : '');

      // If pre-render is available, use it for TTS
      if (onPlayPrerendered) {
        onPlayPrerendered(displayText);
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
    console.log('[SubtitleSync] ▶ Started' + (onPrerender ? ' (with pre-rendering)' : ''));
  }

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastText = null;
    this._prerenderRequested.clear();
    this._lastLookaheadIndex = -1;
    console.log('[SubtitleSync] ⏹ Stopped');
  }

  /**
   * Reset text tracking state when user seeks in the video.
   * Forces subtitle re-trigger at the new position.
   */
  resetTracking() {
    this.lastText = null;
    this._lastLookaheadIndex = -1;
    console.log('[SubtitleSync] 🔄 Tracking reset (seek detected)');
  }

  get isLoaded() {
    return this.events.length > 0;
  }
}

window.SubtitleSync = SubtitleSync;
