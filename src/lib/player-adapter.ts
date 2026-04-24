/**
 * BasePlayerAdapter — Abstract interface for media players.
 * Every source (YouTube, Netflix, etc.) must implement this.
 */

export type PlayerState = 'play' | 'pause' | 'seeking' | 'seeked' | 'ended' | 'ratechange' | 'timeupdate';

export class BasePlayerAdapter {
  protected video: HTMLMediaElement;
  onStateChange: ((state: PlayerState, data: any) => void) | null = null;

  constructor(videoElement: HTMLMediaElement) {
    if (!videoElement) throw new Error('Video element is required');
    this.video = videoElement;
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
    this.video.addEventListener('timeupdate', () => this._emit('timeupdate', { currentTime: this.video.currentTime }));
  }

  destroy() {
    // Optional cleanup
  }

  play() { this.video.play(); }
  pause() { this.video.pause(); }
  seek(time: number) { this.video.currentTime = time; }

  getCurrentTime() { return this.video.currentTime; }
  getDuration() { return this.video.duration; }
  isPaused() { return this.video.paused; }
  getPlaybackRate() { return this.video.playbackRate; }

  protected _emit(state: PlayerState, data: any = {}) {
    if (this.onStateChange) {
      this.onStateChange(state, data);
    }
  }
}
