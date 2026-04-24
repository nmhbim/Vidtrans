import { BasePlayerAdapter } from '../player-adapter';

/**
 * YouTubeAdapter — Specific implementation for YouTube player.
 */
export class YouTubeAdapter extends BasePlayerAdapter {
  constructor(videoElement: HTMLMediaElement) {
    super(videoElement);
    console.log('[YouTubeAdapter] 📺 Initialized for video:', videoElement);
  }

  hideNativeCaptions() {
    if (typeof document === 'undefined') return;
    const ytpCaptions = document.querySelector('.ytp-caption-window-container') as HTMLElement;
    if (ytpCaptions) ytpCaptions.style.display = 'none';
  }

  showNativeCaptions() {
    if (typeof document === 'undefined') return;
    const ytpCaptions = document.querySelector('.ytp-caption-window-container') as HTMLElement;
    if (ytpCaptions) ytpCaptions.style.display = '';
  }
}
