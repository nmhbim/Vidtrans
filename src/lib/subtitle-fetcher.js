import { YouTubeExtractor } from './extractors/youtube-extractor';
import { JWPlayerExtractor } from './extractors/jwplayer-extractor';
/**
 * Subtitle Fetcher - Manager for various platform extractors
 */
export class SubtitleFetcher {
    VERSION = '2.0.0';
    extractors = [];
    constructor() {
        this.registerExtractors();
    }
    /**
     * Register available extractors
     */
    registerExtractors() {
        this.extractors.push(new YouTubeExtractor());
        this.extractors.push(new JWPlayerExtractor());
        // Future extractors:
        // this.extractors.push(new TikTokExtractor());
    }
    /**
     * Detect the platform and return the appropriate extractor
     */
    getExtractor(url) {
        try {
            const urlObj = new URL(url);
            for (const extractor of this.extractors) {
                if (extractor.canHandle(urlObj)) {
                    return extractor;
                }
            }
        }
        catch (e) {
            console.error('[SubtitleFetcher] Error detecting platform:', e);
        }
        return null;
    }
    /**
     * Main entry point to fetch subtitles
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
