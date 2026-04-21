/**
 * TikTok Subtitle Extractor (Stub)
 */
class TikTokExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'TikTok';
  }

  canHandle(urlObj) {
    return urlObj.hostname.includes('tiktok.com');
  }

  async extract(url, lang = 'en') {
    console.log('[TikTokExtractor] Subtitle extraction not yet implemented for TikTok');
    // Implement TikTok specific logic here
    return null;
  }
}

window.TikTokExtractor = TikTokExtractor;
