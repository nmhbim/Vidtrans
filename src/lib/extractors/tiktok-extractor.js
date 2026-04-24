import { BaseExtractor } from './base-extractor';
export class TikTokExtractor extends BaseExtractor {
    constructor() {
        super();
        this.name = 'TikTok';
    }
    canHandle(urlObj) {
        return urlObj.hostname.includes('tiktok.com');
    }
    async extract(url, lang) {
        console.log('[TikTokExtractor] Extracting from:', url);
        // TikTok extraction logic...
        return null;
    }
}
