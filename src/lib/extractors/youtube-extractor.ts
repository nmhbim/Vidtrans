import { BaseExtractor } from './base-extractor';

export class YouTubeExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'YouTube';
  }

  canHandle(urlObj: URL): boolean {
    return urlObj.hostname.includes('youtube.com') || urlObj.hostname.includes('youtu.be');
  }

  get networkRules(): chrome.webRequest.RequestFilter {
    return { urls: ['*://www.youtube.com/api/timedtext*'] };
  }

  async onNetworkData(url: string, details: any): Promise<void> {
    if (!url.includes('/api/timedtext') || !url.includes('fmt=json3')) return;

    try {
      const u = new URL(url);
      const pot = u.searchParams.get('pot');
      const videoId = u.searchParams.get('v');
      if (!pot || !videoId) return;

      console.log(`[YouTubeExtractor] Sniffed sub URL for ${videoId}`);
      chrome.tabs.sendMessage(details.tabId, { type: 'SUB_URL_CAPTURED', url, videoId }).catch(() => {});
    } catch (e) {}
  }

  async extract(url: string, lang = 'en'): Promise<{events: any[], lang: string} | null> {
    // Existing logic from youtube-extractor.js would go here
    // For now, I'll keep the original logic but typed
    return null; // Placeholder
  }
}
