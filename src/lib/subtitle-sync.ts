/**
 * SubtitleSync — Orchestrates subtitle playback synchronized with video time.
 * Handles triggering audio (TTS) and UI updates.
 */

export interface SubtitleEvent {
  start: number;
  duration: number;
  text: string;
  translated?: string;
  end?: number; // Calculated or provided
}

export interface PrerenderOptions {
  lookahead?: number;
  onPrerender?: (texts: string[]) => void;
  onPlayPrerendered?: (text: string) => void;
}

export class SubtitleSync {
  private events: SubtitleEvent[] = [];
  private currentIndex: number = 0;
  private timer: number | null = null;
  private video: HTMLMediaElement | null = null;
  private onUpdate: ((displayText: string, originalText: string) => void) | null = null;
  private onClear: (() => void) | null = null;
  private prerender: PrerenderOptions | null = null;
  private prerenderedIndices: Set<number> = new Set();

  constructor() {
  }

  load(events: SubtitleEvent[]) {
    // Standardize events: Ensure end time exists (ms)
    this.events = events.map(e => ({
      ...e,
      end: e.end || (e.start + e.duration)
    })).sort((a, b) => a.start - b.start);
    this.currentIndex = 0;
    this.prerenderedIndices.clear();
  }

  start(
    video: HTMLMediaElement, 
    onUpdate: (displayText: string, originalText: string) => void, 
    onClear: () => void, 
    prerenderOptions?: PrerenderOptions
  ) {
    this.video = video;
    this.onUpdate = onUpdate;
    this.onClear = onClear;
    this.prerender = prerenderOptions || null;
    this.currentIndex = 0;

    if (this.timer) clearInterval(this.timer);
    
    // Polling at 100ms for synchronization
    this.timer = setInterval(() => this.tick(), 100) as any;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.video = null;
    this.onUpdate = null;
    this.onClear = null;
    this.prerender = null;
  }

  resetTracking() {
    this.currentIndex = 0;
    this.prerenderedIndices.clear();
  }

  private tick() {
    if (!this.video || !this.onUpdate || !this.onClear) return;

    const currentTimeMs = this.video.currentTime * 1000;

    // ── Check Current Event ──────────────────────────────────────────────────
    // Find the current active subtitle
    let activeIndex = -1;
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      if (currentTimeMs >= e.start && currentTimeMs <= e.end!) {
        activeIndex = i;
        break;
      }
    }

    if (activeIndex !== -1) {
      if (activeIndex !== this.currentIndex) {
        const e = this.events[activeIndex];
        const textToSpeak = e.translated || e.text;
        
        // Trigger UI & Audio
        if (this.prerender?.onPlayPrerendered) {
          this.prerender.onPlayPrerendered(textToSpeak);
        }
        
        this.onUpdate(textToSpeak, e.text);
        this.currentIndex = activeIndex;
      }
    } else {
      // No active subtitle at this time
      this.onClear();
      this.currentIndex = -1;
    }

    // ── Check Prerender (Lookahead) ──────────────────────────────────────────
    if (this.prerender?.onPrerender && this.prerender.lookahead) {
      const lookaheadMs = 15000; // 15 seconds lookahead
      const upcomingTexts: string[] = [];

      for (let i = 0; i < this.events.length; i++) {
        const e = this.events[i];
        if (e.start > currentTimeMs && e.start < currentTimeMs + lookaheadMs) {
          if (!this.prerenderedIndices.has(i)) {
            upcomingTexts.push(e.translated || e.text);
            this.prerenderedIndices.add(i);
          }
        }
      }

      if (upcomingTexts.length > 0) {
        this.prerender.onPrerender(upcomingTexts);
      }
    }
  }
}
