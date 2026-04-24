/**
 * SubtitleSync — Orchestrates subtitle playback synchronized with video time.
 * Handles triggering audio (TTS) and UI updates.
 */
export class SubtitleSync {
    events = [];
    currentIndex = 0;
    timer = null;
    video = null;
    onUpdate = null;
    onClear = null;
    prerender = null;
    prerenderedIndices = new Set();
    constructor() {
    }
    load(events) {
        // Standardize events: Ensure end time exists (ms)
        this.events = events.map(e => ({
            ...e,
            end: e.end || (e.start + e.duration)
        })).sort((a, b) => a.start - b.start);
        this.currentIndex = 0;
        this.prerenderedIndices.clear();
    }
    start(video, onUpdate, onClear, prerenderOptions) {
        this.video = video;
        this.onUpdate = onUpdate;
        this.onClear = onClear;
        this.prerender = prerenderOptions || null;
        this.currentIndex = 0;
        if (this.timer)
            clearInterval(this.timer);
        // Polling at 100ms for synchronization
        this.timer = window.setInterval(() => this.tick(), 100);
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
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
    tick() {
        if (!this.video || !this.onUpdate || !this.onClear)
            return;
        const currentTimeMs = this.video.currentTime * 1000;
        // ── Check Current Event ──────────────────────────────────────────────────
        // Find the current active subtitle
        let activeIndex = -1;
        for (let i = 0; i < this.events.length; i++) {
            const e = this.events[i];
            if (currentTimeMs >= e.start && currentTimeMs <= e.end) {
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
        }
        else {
            // No active subtitle at this time
            this.onClear();
            this.currentIndex = -1;
        }
        // ── Check Prerender (Lookahead) ──────────────────────────────────────────
        if (this.prerender?.onPrerender && this.prerender.lookahead) {
            const lookaheadMs = 15000; // 15 seconds lookahead
            const upcomingTexts = [];
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
