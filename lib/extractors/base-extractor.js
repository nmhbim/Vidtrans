/**
 * Base class for subtitle extractors
 */
class BaseExtractor {
  constructor() {
    this.name = 'Base';
  }

  /**
   * Check if this extractor can handle the given URL
   * @param {URL} urlObj 
   * @returns {boolean}
   */
  canHandle(urlObj) {
    return false;
  }

  /**
   * Extract subtitles for the given URL
   * @param {string} url 
   * @param {string} lang 
   * @returns {Promise<{events: Array, lang: string}|null>}
   */
  async extract(url, lang) {
    throw new Error('Extract method not implemented');
  }

  /**
   * Helper for fetch with timeout
   */
  async fetchWithTimeout(url, options = {}, timeout = 7000) {
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

window.BaseExtractor = BaseExtractor;
