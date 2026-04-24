/**
 * Base class for subtitle extractors
 */
export class BaseExtractor {
    name = 'Base';
    constructor() {
    }
    /**
     * Check if this extractor can handle the given URL
     */
    canHandle(urlObj) {
        return false;
    }
    /**
     * Optional: Define network filters if this extractor needs to sniff requests.
     */
    get networkRules() {
        return null;
    }
    /**
     * Callback when a network request matching networkRules is completed.
     */
    async onNetworkData(url, details) {
        // To be implemented by subclasses if needed
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
        }
        catch (err) {
            clearTimeout(id);
            throw err;
        }
    }
}
