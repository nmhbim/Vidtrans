/**
 * Base class for subtitle extractors
 */
export abstract class BaseExtractor {
  name: string = 'Base';

  constructor() {
  }

  /**
   * Check if this extractor can handle the given URL
   */
  canHandle(urlObj: URL): boolean {
    return false;
  }

  /**
   * Extract subtitles for the given URL
   */
  abstract extract(url: string, lang?: string): Promise<{events: any[], lang: string} | null>;

  /**
   * Optional: Define network filters if this extractor needs to sniff requests.
   */
  get networkRules(): chrome.webRequest.RequestFilter | null {
    return null;
  }

  /**
   * Callback when a network request matching networkRules is completed.
   */
  async onNetworkData(url: string, details: any): Promise<void> {
    // To be implemented by subclasses if needed
  }

  /**
   * Helper for fetch with timeout
   */
  async fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 7000): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(id);
      return response;
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  }
}
