/**
 * Subtitle Fetcher - Manager for various platform extractors
 * Version: 2.0.0
 */
class SubtitleFetcher {
  constructor() {
    this.VERSION = '2.0.0';
    this.extractors = [];
    this.registerExtractors();
  }

  /**
   * Register available extractors
   */
  registerExtractors() {
    if (window.YouTubeExtractor) {
      this.extractors.push(new window.YouTubeExtractor());
    }
    if (window.TikTokExtractor) {
      this.extractors.push(new window.TikTokExtractor());
    }
    // Future extractors can be registered here:
    // if (window.FacebookExtractor) this.extractors.push(new window.FacebookExtractor());
  }

  /**
   * Detect the platform and return the appropriate extractor
   * @param {string} url 
   * @returns {BaseExtractor|null}
   */
  getExtractor(url) {
    try {
      const urlObj = new URL(url);
      for (const extractor of this.extractors) {
        if (extractor.canHandle(urlObj)) {
          return extractor;
        }
      }
    } catch (e) {
      console.error('[SubtitleFetcher] Error detecting platform:', e);
    }
    return null;
  }

  /**
   * Main entry point to fetch subtitles
   * @param {string} url 
   * @param {string} lang 
   * @returns {Promise<{events: Array, lang: string}|null>}
   */
  async fetchSubtitles(url, lang = 'en') {
    const extractor = this.getExtractor(url);
    if (!extractor) {
      console.warn(`[SubtitleFetcher] No extractor found for URL: ${url}`);
      return null;
    }

    console.log(`[SubtitleFetcher] 🚀 Using ${extractor.name} extractor for platform detection.`);
    return await extractor.extract(url, lang);
  }
}

// Initialize and make globally available
window.SubtitleFetcher = SubtitleFetcher;
console.log('[SubtitleFetcher] ✅ SubtitleFetcher v2.0.0 (Multi-Platform) loaded.');
