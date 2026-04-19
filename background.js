// background.js — Service Worker
// Handles tabCapture, offscreen document lifecycle, and message routing

/** @type {number|null} */
let activeCaptureTabId = null;

/** @type {string|null} */
let currentStreamId = null;

// ── Extension Icon Click ────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  // Stop existing capture if tab changed
  if (activeCaptureTabId !== tab.id) {
    if (activeCaptureTabId !== null) {
      stopAllCapture();
    }

    // Create offscreen document (REQUIRED before getMediaStreamId)
    await ensureOffscreenDocument();

    // tabCapture.getMediaStreamId() must be called HERE (user gesture context)
    // StreamId expires after ~5 seconds — must use immediately
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id
      });

      if (!streamId) {
        console.error('[Background] getMediaStreamId returned null');
        return;
      }

      activeCaptureTabId = tab.id;
      currentStreamId = streamId;

      // Pass streamId to offscreen so it can call getUserMedia
      chrome.runtime.sendMessage({
        type: 'CONSUME_STREAM',
        streamId: streamId,
        tabId: tab.id
      }).catch(err => {
        console.error('[Background] Failed to send streamId to offscreen:', err);
      });

    } catch (err) {
      console.error('[Background] TabCapture error:', err);
    }
  }
});

// ── Offscreen Document ─────────────────────────────────────────────────────

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

/**
 * Create offscreen document if it doesn't exist
 */
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });

  if (existingContexts.length > 0) {
    return; // Already exists
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capturing tab audio for real-time translation'
  });
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STOP_CAPTURE') {
    stopAllCapture();
    sendResponse({ success: true });

  } else if (message.type === 'GET_CAPTURE_STATUS') {
    sendResponse({
      active: activeCaptureTabId !== null,
      tabId: activeCaptureTabId
    });
  }

  return true; // Keep message channel open for async response
});

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Inject content script into tab
 * @param {number} tabId
 */
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
  } catch (err) {
    // Script may already be injected — ignore
    if (!err.message.includes('already injected')) {
      console.error('[Background] Failed to inject content script:', err);
    }
  }
}

/**
 * Stop all capture and cleanup
 */
function stopAllCapture() {
  activeCaptureTabId = null;
  currentStreamId = null;

  // Notify offscreen to stop
  chrome.runtime.sendMessage({ type: 'STOP_OFFSCREEN_CAPTURE' }).catch(() => {});

  // Close offscreen document
  closeOffscreenDocument();
}