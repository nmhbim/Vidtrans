import { BaseExtractor } from '../lib/extractors/base-extractor';

export class NetworkMonitor {
  constructor(private extractors: BaseExtractor[]) {
  }

  init() {
    console.log('[NetworkMonitor] Initializing...');
    this.extractors.forEach(extractor => {
      const rules = extractor.networkRules;
      if (rules && Array.isArray(rules.urls)) {
        console.log(`[NetworkMonitor] Registering rule for ${extractor.name}:`, rules.urls);
        chrome.webRequest.onCompleted.addListener(
          (details) => {
            extractor.onNetworkData(details.url, details);
          },
          { urls: rules.urls }
        );
      }
    });
  }
}
