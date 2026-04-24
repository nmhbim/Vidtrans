import { BaseExtractor } from './base-extractor';

export class JWPlayerExtractor extends BaseExtractor {
  private _capturedTracks: Map<string, any[]> = new Map();

  constructor() {
    super();
    this.name = 'JWPlayer';
  }

  canHandle(urlObj: URL): boolean {
    return urlObj.hostname.includes('skilljar.com') || urlObj.hostname.includes('jwplayer.com');
  }

  get networkRules(): chrome.webRequest.RequestFilter {
    return { urls: ["*://cdn.jwplayer.com/v2/*/playback.json*"] };
  }

  async onNetworkData(url: string, details: any): Promise<void> {
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
      } catch (err) {
        console.error('[JWPlayerExtractor] Error sniffing playback JSON:', err);
      }
    }
  }

  async extract(url: string, lang = 'en'): Promise<{events: any[], lang: string} | null> {
    if (this._capturedTracks.size === 0) return null;

    const tracks = Array.from(this._capturedTracks.values())[0];
    const targetTrack = tracks.find(t => t.label?.toLowerCase() === lang.toLowerCase()) || 
                      tracks.find(t => t.label?.toLowerCase() === 'english') ||
                      tracks[0];

    if (!targetTrack || !targetTrack.file) return null;

    const resp = await fetch(targetTrack.file);
    const srtText = await resp.text();

    return {
      events: this.parseSRT(srtText),
      lang: targetTrack.label
    };
  }

  private parseSRT(srtText: string): any[] {
    const events: any[] = [];
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

  private srtTimeToSeconds(timeStr: string): number {
    const [hms, ms] = timeStr.split(',');
    const [h, m, s] = hms.split(':').map(parseFloat);
    return h * 3600 + m * 60 + s + parseFloat(ms) / 1000;
  }
}
