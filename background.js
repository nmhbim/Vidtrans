// background.js — Service Worker
// Handles tabCapture, offscreen document lifecycle, and message routing

/** @type {number|null} */
let activeCaptureTabId = null;

/** @type {string|null} */
let currentStreamId = null;

// Initial state restoration
const storageArea = chrome.storage.session || chrome.storage.local;
storageArea.get(['activeCaptureTabId', 'currentStreamId']).then(data => {
  activeCaptureTabId = data.activeCaptureTabId || null;
  currentStreamId = data.currentStreamId || null;
  console.log('[Background] 🔄 State restored:', { activeCaptureTabId, currentStreamId });
});

// Allow content scripts to access chrome.storage.session
if (chrome.storage.session) {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch(err => console.error('[Background] Failed to set session access level:', err));
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Send message to offscreen with retry (offscreen may not be ready yet)
 * @param {object} message
 * @param {number} [maxRetries=5]
 * @returns {Promise<void>}
 */
async function sendToOffscreen(message, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await chrome.runtime.sendMessage(message);
      return; // Success
    } catch (err) {
      if (attempt < maxRetries - 1) {
        // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms
        await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt)));
        continue;
      }
      // All retries exhausted
      console.error('[Background] Failed to reach offscreen:', err.message);
    }
  }
}

// ── Extension Icon Click ────────────────────────────────────────────────────

/**
 * Shared handler for icon click and keyboard shortcut
 * @param {chrome.tabs.Tab} tab
 */
async function handleAction(tab) {
  if (!tab.id) return;
  console.log('[Background] 🖱️ Action triggered for tab:', tab.id);

  // 1. Try to toggle panel via message, if it fails (not injected), inject it
  try {
    console.log('[Background] 📤 Sending TOGGLE_PANEL to tab:', tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch (err) {
    console.log('[Background] 💉 UI not ready, injecting content script...');
    await injectContentScript(tab.id);
    // Give it a bit more time to initialize listeners
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL', show: true }).catch(() => {});
    }, 300);
  }

  // 2. Always ensure capture is active when the icon is clicked/shortcut used
  // But ONLY if we're not already capturing this tab
  if (activeCaptureTabId === tab.id && currentStreamId) {
    console.log('[Background] 🎙️ Tab already being captured, skipping stream ID request.');
    return;
  }

  console.log('[Background] 🎙️ Establishing/Refreshing capture for tab:', tab.id);
  
  if (activeCaptureTabId !== null && activeCaptureTabId !== tab.id) {
    // If switching tabs, stop previous
    stopAllCapture();
  }

  await ensureOffscreenDocument();

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id
    });

    if (!streamId) {
      console.error('[Background] ❌ getMediaStreamId returned null');
      return;
    }

    activeCaptureTabId = tab.id;
    currentStreamId = streamId;
    await storageArea.set({ activeCaptureTabId, currentStreamId });
    console.log('[Background] ✅ Stream ID obtained:', streamId.substring(0, 10) + '...');

    await sendToOffscreen({
      type: 'CONSUME_STREAM',
      streamId: streamId,
      tabId: tab.id
    });
    console.log('[Background] 📤 CONSUME_STREAM sent to offscreen');

  } catch (err) {
    // If it's the "active stream" error, we might just need to refresh the state
    if (err.message.includes('active stream')) {
      console.warn('[Background] ⚠️ Tab already has an active stream according to Chrome.');
    } else {
      console.error('[Background] ❌ TabCapture error:', err);
    }
  }
}

chrome.action.onClicked.addListener(handleAction);

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-panel') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      handleAction(tab);
    }
  }
});

// ── Offscreen Document ─────────────────────────────────────────────────────

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

/**
 * Create offscreen document if it doesn't exist
 */
async function ensureOffscreenDocument() {
  try {
    if (chrome.runtime.getContexts) {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
      });
      if (existingContexts.length > 0) return;
    }
  } catch (err) {
    // getContexts might fail or not be supported, proceed to create
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capturing tab audio for real-time translation'
    });
    console.log('[Background] 📄 Offscreen document created');
  } catch (err) {
    if (err.message.includes('Only a single offscreen document may be created')) {
      // Already exists, ignore
    } else {
      console.error('[Background] ❌ Failed to create offscreen document:', err);
    }
  }
}

/**
 * Close offscreen document
 */
async function closeOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });

    if (contexts.length > 0) {
      await chrome.offscreen.closeDocument();
    }
  } catch (err) {
    // Ignore if already closed
  }
}

// ── Edge TTS Security Bypass (Sec-MS-GEC) ───────────────────────────────────

/**
 * Generates a random hex string for MUID
 */
function generateMuid() {
  const chars = '0123456789ABCDEF';
  let muid = '';
  for (let i = 0; i < 32; i++) {
    muid += chars[Math.floor(Math.random() * 16)];
  }
  return muid;
}

/**
 * Generates the Sec-MS-GEC token required by Microsoft Edge TTS
 * Based on the latest algorithm from rany2/edge-tts
 */
async function generateSecMsGec() {
  const salt = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  
  // Current time in seconds
  let seconds = Math.floor(Date.now() / 1000);
  
  // Round down to the nearest 5 minutes (300 seconds)
  seconds -= seconds % 300;
  
  // Convert to Windows File Time (100-nanosecond intervals)
  const ticks = (BigInt(seconds) + 11644473600n) * 10000000n;
  
  const strToHash = `${ticks}${salt}`;
  
  // SHA-256 hash
  const msgUint8 = new TextEncoder().encode(strToHash);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  
  return hashHex;
}

async function updateEdgeTTSHeaders() {
  const token = await generateSecMsGec();
  currentEdgeToken = token;
  const muid = generateMuid();
  
  const rules = [
    {
      id: 1001,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold' },
          { header: 'User-Agent', operation: 'set', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.3650.75 Safari/537.36 Edg/143.0.3650.75' },
          { header: 'Sec-MS-GEC', operation: 'set', value: token },
          { header: 'Sec-MS-GEC-Version', operation: 'set', value: '1-143.0.3650' },
          { header: 'Sec-CH-UA', operation: 'set', value: '" Not;A Brand";v="99", "Microsoft Edge";v="143", "Chromium";v="143"' },
          { header: 'Sec-CH-UA-Mobile', operation: 'set', value: '?0' },
          { header: 'Sec-CH-UA-Platform', operation: 'set', value: '"Windows"' },
          { header: 'Sec-WebSocket-Protocol', operation: 'set', value: 'synthesize' },
          { header: 'Sec-WebSocket-Version', operation: 'set', value: '13' },
          { header: 'Accept-Encoding', operation: 'set', value: 'gzip, deflate, br, zstd' },
          { header: 'Accept-Language', operation: 'set', value: 'en-US,en;q=0.9' },
          { header: 'Cookie', operation: 'set', value: `MUID=${muid}` },
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
      removeRuleIds: [1, 1001],
      addRules: rules
    });
    console.log('[Background] 🛡️ Edge TTS Headers updated');
  } catch (err) {
    console.error('[Background] ❌ Failed to update DNR rules:', err);
  }
}

// Update headers on startup and then every 1 minute
chrome.runtime.onInstalled.addListener(updateEdgeTTSHeaders);
chrome.runtime.onStartup.addListener(updateEdgeTTSHeaders);
setInterval(updateEdgeTTSHeaders, 60 * 1000);

// ── Tab Events ─────────────────────────────────────────────────────────────

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeCaptureTabId) {
    stopAllCapture();
  }
});

// Cleanup when tab navigates (different page)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === activeCaptureTabId && changeInfo.status === 'complete') {
    // Page loaded — re-inject content script if needed
    chrome.tabs.sendMessage(tabId, { type: 'CHECK_UI' }).catch(() => {
      // UI not injected — inject it
      injectContentScript(tabId);
    });
  }
});

// ── Message Routing ────────────────────────────────────────────────────────

let currentEdgeToken = '';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STOP_CAPTURE') {
    stopAllCapture();
    sendResponse({ success: true });

  } else if (message.type === 'GET_EDGE_TOKEN') {
    sendResponse({ token: currentEdgeToken });

  } else if (message.type === 'GET_EDGE_VOICES') {
    fetch('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4')
      .then(res => res.json())
      .then(data => sendResponse({ voices: data }))
      .catch(err => {
        console.error('[Background] Failed to fetch voices:', err);
        sendResponse({ voices: null, error: err.message });
      });
    return true; // Async response

  } else if (message.type === 'GET_CAPTURE_STATUS') {
    sendResponse({
      active: activeCaptureTabId !== null,
      tabId: activeCaptureTabId
    });

  } else if (['START_TRANSLATION', 'STOP_TRANSLATION', 'SPEAK_SUBTITLE', 'TEST_TTS', 'PROCESS_SUBTITLES'].includes(message.type)) {
    console.log(`[Background] ⚡ Forwarding ${message.type} to offscreen`);
    // Ensure offscreen exists before forwarding
    ensureOffscreenDocument().then(() => {
      sendToOffscreen(message).then(() => {
        console.log(`[Background] ✅ ${message.type} forwarded successfully`);
        sendResponse({ success: true });
      });
    });
    return true;

  } else if (['UPDATE_TRANSCRIPT', 'UPDATE_TRANSCRIPT_ERROR', 'UPDATE_TRANSCRIPT_STATUS'].includes(message.type)) {
    // Forward from offscreen to content script
    if (activeCaptureTabId) {
      console.log(`[Background] 🔄 Forwarding ${message.type} to content tab ${activeCaptureTabId}`);
      chrome.tabs.sendMessage(activeCaptureTabId, message).catch((err) => {
        console.warn(`[Background] ⚠️ Failed to forward ${message.type}:`, err.message);
      });
    } else {
      console.warn(`[Background] ⚠️ Received ${message.type} but activeCaptureTabId is null`);
    }
  }

  // Only return true if we are returning an async response
  // The forwarded messages (START_TRANSLATION, etc.) use async sendResponse
  if (['START_TRANSLATION', 'STOP_TRANSLATION', 'SPEAK_SUBTITLE', 'TEST_TTS', 'PROCESS_SUBTITLES'].includes(message.type)) {
    return true; 
  }
  return false;
});

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Inject content script into tab with dependencies
 * @param {number} tabId
 */
async function injectContentScript(tabId) {
  try {
    // Inject dependencies first, then the main content script
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'lib/utils.js',
        'lib/extractors/base-extractor.js',
        'lib/extractors/youtube-extractor.js',
        'lib/extractors/tiktok-extractor.js',
        'lib/subtitle-fetcher.js',
        'content/content.js'
      ]
    });
    console.log('[Background] ✅ Content script and dependencies injected');
  } catch (err) {
    // Script may already be injected — ignore
    if (!err.message.includes('already injected') && !err.message.includes('context invalidated')) {
      console.error('[Background] ❌ Failed to inject content script:', err);
    }
  }
}

/**
 * Stop all capture and cleanup
 */
function stopAllCapture() {
  activeCaptureTabId = null;
  currentStreamId = null;
  storageArea.remove(['activeCaptureTabId', 'currentStreamId']);

  // Notify offscreen to stop
  chrome.runtime.sendMessage({ type: 'STOP_OFFSCREEN_CAPTURE' }).catch(() => {});

  // Close offscreen document
  closeOffscreenDocument();
}

// ── Subtitle URL Capture (via webRequest) ────────────────────────────────────
//
// YouTube generates valid timedtext URLs with real poTokens when the player
// loads subtitles. We intercept these via webRequest and cache them per tab.
// The content script then uses these pre-validated URLs instead of building
// its own (which requires a valid pot token we may not be able to generate).

/** @type {Map<number, {url: string, videoId: string, timestamp: number}>} */
const capturedSubUrls = new Map();

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const url = details.url;
    if (!url.includes('/api/timedtext') || !url.includes('fmt=json3')) return;

    try {
      const u = new URL(url);
      const pot = u.searchParams.get('pot');
      const videoId = u.searchParams.get('v');
      const kind = u.searchParams.get('kind');

      // Only cache subtitle requests that have a pot token
      if (!pot || !videoId) return;

      const entry = { url, videoId, timestamp: Date.now() };
      capturedSubUrls.set(details.tabId, entry);

      console.log(`[Background] 🎯 Captured subtitle URL for v=${videoId} kind=${kind || 'manual'} tab=${details.tabId}`);

      // Notify content script immediately so it can update its cache
      chrome.tabs.sendMessage(details.tabId, {
        type: 'SUB_URL_CAPTURED',
        url,
        videoId,
      }).catch(() => {}); // Tab may not have content script yet
    } catch (e) {
      console.error('[Background] webRequest parse error:', e);
    }
  },
  { urls: ['*://www.youtube.com/api/timedtext*'] }
);

// Handle content script request for cached subtitle URL
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CAPTURED_SUB_URL') {
    const tabId = sender.tab?.id;
    const entry = tabId ? capturedSubUrls.get(tabId) : null;

    // URLs expire after 5 minutes (YouTube signatures expire)
    const isValid = entry && (Date.now() - entry.timestamp < 5 * 60 * 1000);

    if (isValid && (!message.videoId || entry.videoId === message.videoId)) {
      sendResponse({ url: entry.url });
    } else {
      sendResponse({ url: null });
    }
    return false; // Sync response
  }
});

updateEdgeTTSHeaders();