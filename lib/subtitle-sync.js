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
 */
class SubtitleSync {
  constructor() {
    /** @type {Array<{start: number, duration: number, text: string, translated?: string}>} */
    this.events = [];
    this.rafId = null;
    this.lastText = null;
  }

  /**
   * Load subtitle events. Events must have { start, duration, text, translated? }.
   * @param {Array} events
   */
  load(events) {
    this.events = [...events].sort((a, b) => a.start - b.start);
    this.lastText = null;
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
   * Start the rAF sync loop.
   * @param {HTMLVideoElement} video
   * @param {Function} onShow - (displayText: string, originalText: string) => void
   * @param {Function} onHide - () => void
   */
  start(video, onShow, onHide) {
    this.stop();

    const tick = () => {
      if (!video || video.paused || video.ended) {
        this.rafId = requestAnimationFrame(tick);
        return;
      }

      const currentMs = video.currentTime * 1000;
      // Compensate for Online TTS network latency (Lead Time)
      const leadTimeMs = 350; 
      
      const event = this._findEvent(currentMs + leadTimeMs);

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

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
    console.log('[SubtitleSync] ▶ Started');
  }

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastText = null;
    console.log('[SubtitleSync] ⏹ Stopped');
  }

  get isLoaded() {
    return this.events.length > 0;
  }
}

window.SubtitleSync = SubtitleSync;
