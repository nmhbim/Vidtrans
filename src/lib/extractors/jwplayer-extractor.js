import { BaseExtractor } from './base-extractor';
export class JWPlayerExtractor extends BaseExtractor {
    _capturedTracks = new Map();
    constructor() {
        super();
        this.name = 'JWPlayer';
    }
    canHandle(urlObj) {
        return urlObj.hostname.includes('skilljar.com') || urlObj.hostname.includes('jwplayer.com');
    }
    get networkRules() {
        return { urls: ["*://cdn.jwplayer.com/v2/*/playback.json*"] };
    }
    async onNetworkData(url, details) {
        if (url.includes('playback.json')) {
            try {
                console.log(`[JWPlayerExtractor] Sniffed playback JSON: ${url}`);
                const response = await fetch(url);
                const data = await response.json();
                if (data.playlist && data.playlist[0]) {
                    const mediaId = data.playlist[0].mediaid;
                    const tracks = data.playlist[0].tracks || [];
                    this._capturedTracks.set(mediaId, tracks);
                    chrome.runtime.sendMessage({
                        type: 'EXTRACTOR_DATA_READY',
                        extractor: this.name,
                        mediaId: mediaId,
                        tracks: tracks
                    });
                }
            }
            catch (err) {
                console.error('[JWPlayerExtractor] Error sniffing playback JSON:', err);
            }
        }
    }
    async extract(url, lang = 'en') {
        if (this._capturedTracks.size === 0)
            return null;
        const tracks = Array.from(this._capturedTracks.values())[0];
        const targetTrack = tracks.find(t => t.label?.toLowerCase() === lang.toLowerCase()) ||
            tracks.find(t => t.label?.toLowerCase() === 'english') ||
            tracks[0];
        if (!targetTrack || !targetTrack.file)
            return null;
        const resp = await fetch(targetTrack.file);
        const srtText = await resp.text();
        return {
            events: this.parseSRT(srtText),
            lang: targetTrack.label
        };
    }
    parseSRT(srtText) {
        const events = [];
        const blocks = srtText.trim().split(/\n\s*\n/);
        for (const block of blocks) {
            const lines = block.split('\n');
            if (lines.length >= 3) {
                const timeMatch = lines[1].match(/(\d+:\d+:\d+,\d+) --> (\d+:\d+:\d+,\d+)/);
                if (timeMatch) {
                    const start = this.srtTimeToSeconds(timeMatch[1]);
                    const end = this.srtTimeToSeconds(timeMatch[2]);
                    const text = lines.slice(2).join(' ').replace(/<[^>]*>/g, '');
                    events.push({ start, end, text });
                }
            }
        }
        return events;
    }
    srtTimeToSeconds(timeStr) {
        const [hms, ms] = timeStr.split(',');
        const [h, m, s] = hms.split(':').map(parseFloat);
        return h * 3600 + m * 60 + s + parseFloat(ms) / 1000;
    }
}
