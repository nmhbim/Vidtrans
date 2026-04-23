/**
 * BasePlayerAdapter — Abstract interface for media players.
 * Every source (YouTube, Netflix, etc.) must implement this.
 */
class BasePlayerAdapter {
  /**
   * @param {HTMLMediaElement} videoElement
   */
  constructor(videoElement) {
    if (!videoElement) throw new Error('Video element is required');
    this.video = videoElement;
    
    /**
     * @type {Function|null} 
     * Callback for state changes: (state: 'play'|'pause'|'seeking'|'seeked'|'ratechange', data: any)
     */
    this.onStateChange = null;
  }

  /**
   * Bind DOM events to the adapter logic.
   */
  bindEvents() {
    this.video.addEventListener('play', () => this._emit('play'));
    this.video.addEventListener('pause', () => this._emit('pause'));
    this.video.addEventListener('seeking', () => this._emit('seeking'));
    this.video.addEventListener('seeked', () => this._emit('seeked'));
    this.video.addEventListener('ended', () => this._emit('ended'));
    this.video.addEventListener('ratechange', () => this._emit('ratechange', { playbackRate: this.video.playbackRate }));
    
    // Track current time updates (optional, for fine-grained sync)
    this.video.addEventListener('timeupdate', () => this._emit('timeupdate', { currentTime: this.video.currentTime }));
  }

  /**
   * Clean up listeners.
   */
  destroy() {
    // In a real implementation, we would removeEventListener, 
    // but for extensions, usually, the video element is destroyed or page is refreshed.
  }

  // --- Controls ---
  play() { this.video.play(); }
  pause() { this.video.pause(); }
  seek(time) { this.video.currentTime = time; }

  // --- Getters ---
  getCurrentTime() { return this.video.currentTime; }
  getDuration() { return this.video.duration; }
  isPaused() { return this.video.paused; }
  getPlaybackRate() { return this.video.playbackRate; }

  /** @internal */
  _emit(state, data = {}) {
    if (this.onStateChange) {
      this.onStateChange(state, data);
    }
  }
}

window.BasePlayerAdapter = BasePlayerAdapter;
