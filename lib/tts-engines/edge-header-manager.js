/**
 * edge-header-manager.js
 * Handles Sec-MS-GEC token generation and declarativeNetRequest rules
 * for Microsoft Edge TTS security bypass.
 */

export class EdgeHeaderManager {
  static TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  static VERSION = "1-143.0.3650.75";
  static RULE_ID = 1001;

  constructor() {
    this.currentToken = '';
  }

  /**
   * Generates a random hex string for MUID
   */
  generateMuid() {
    const chars = '0123456789ABCDEF';
    let muid = '';
    for (let i = 0; i < 32; i++) {
      muid += chars[Math.floor(Math.random() * 16)];
    }
    return muid;
  }

  /**
   * Generates the Sec-MS-GEC token required by Microsoft Edge TTS
   */
  async generateSecMsGec() {
    // Current time in seconds
    let seconds = Math.floor(Date.now() / 1000);
    
    // Round down to the nearest 5 minutes (300 seconds)
    seconds -= seconds % 300;
    
    // Convert to Windows File Time (100-nanosecond intervals)
    const ticks = (BigInt(seconds) + 11644473600n) * 10000000n;
    
    const strToHash = `${ticks}${EdgeHeaderManager.TRUSTED_CLIENT_TOKEN}`;
    
    // SHA-256 hash
    const msgUint8 = new TextEncoder().encode(strToHash);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    
    this.currentToken = hashHex;
    return hashHex;
  }

  /**
   * Updates declarativeNetRequest rules to inject required headers
   */
  async updateHeaders() {
    const token = await this.generateSecMsGec();
    const muid = this.generateMuid();
    const extensionId = chrome.runtime.id;
    
    const rules = [
      {
        id: EdgeHeaderManager.RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'set', value: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold' },
            { header: 'User-Agent', operation: 'set', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0' },
            { header: 'Sec-MS-GEC', operation: 'set', value: token },
            { header: 'Sec-MS-GEC-Version', operation: 'set', value: EdgeHeaderManager.VERSION },
            { header: 'Sec-CH-UA', operation: 'set', value: '" Not;A Brand";v="99", "Microsoft Edge";v="143", "Chromium";v="143"' },
            { header: 'Sec-CH-UA-Mobile', operation: 'set', value: '?0' },
            { header: 'Sec-CH-UA-Platform', operation: 'set', value: '"Windows"' },
            { header: 'Accept-Encoding', operation: 'set', value: 'gzip, deflate, br, zstd' },
            { header: 'Accept-Language', operation: 'set', value: 'en-US,en;q=0.9' },
            { header: 'Cookie', operation: 'set', value: `muid=${muid};` },
            { header: 'Pragma', operation: 'set', value: 'no-cache' },
            { header: 'Cache-Control', operation: 'set', value: 'no-cache' }
          ]
        },
        condition: {
          urlFilter: '*://speech.platform.bing.com/*',
          resourceTypes: ['websocket', 'xmlhttprequest']
        }
      }
    ];

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [EdgeHeaderManager.RULE_ID],
        addRules: rules
      });
      console.log('[EdgeHeaderManager] 🛡️ Headers updated');
    } catch (err) {
      console.error('[EdgeHeaderManager] ❌ Failed to update rules:', err);
    }
  }

  getToken() {
    return this.currentToken;
  }
}
