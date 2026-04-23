/**
 * YouTubeAdapter — Specific implementation for YouTube player.
 */
class YouTubeAdapter extends BasePlayerAdapter {
  constructor(videoElement) {
    super(videoElement);
    console.log('[YouTubeAdapter] 📺 Initialized for video:', videoElement);
  }

  /**
   * YouTube sometimes has specific behaviors, like showing/hiding native captions.
   */
  hideNativeCaptions() {
    const ytpCaptions = document.querySelector('.ytp-caption-window-container');
    if (ytpCaptions) ytpCaptions.style.display = 'none';
  }

  showNativeCaptions() {
    const ytpCaptions = document.querySelector('.ytp-caption-window-container');
    if (ytpCaptions) ytpCaptions.style.display = '';
  }

  // We can add more YouTube specific logic here (e.g. detecting if it's a Short, etc.)
}

window.YouTubeAdapter = YouTubeAdapter;
