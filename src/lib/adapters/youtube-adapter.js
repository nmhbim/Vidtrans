import { BasePlayerAdapter } from '../player-adapter';
/**
 * YouTubeAdapter — Specific implementation for YouTube player.
 */
export class YouTubeAdapter extends BasePlayerAdapter {
    constructor(videoElement) {
        super(videoElement);
        console.log('[YouTubeAdapter] 📺 Initialized for video:', videoElement);
    }
    hideNativeCaptions() {
        const ytpCaptions = document.querySelector('.ytp-caption-window-container');
        if (ytpCaptions)
            ytpCaptions.style.display = 'none';
    }
    showNativeCaptions() {
        const ytpCaptions = document.querySelector('.ytp-caption-window-container');
        if (ytpCaptions)
            ytpCaptions.style.display = '';
    }
}
