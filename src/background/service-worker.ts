import { EdgeHeaderManager } from '../lib/tts-engines/edge-header-manager';
import { NetworkMonitor } from './network-monitor';
import { YouTubeExtractor } from '../lib/extractors/youtube-extractor';
import { JWPlayerExtractor } from '../lib/extractors/jwplayer-extractor';

const EXTRACTORS = [
  new YouTubeExtractor(),
  new JWPlayerExtractor()
];

// background.js — Service Worker
// Handles tabCapture, offscreen document lifecycle, and message routing

let activeCaptureTabId: number | null = null;
let currentStreamId: string | null = null;

const edgeManager = new EdgeHeaderManager();

// Initial state restoration
const storageArea = chrome.storage.session || chrome.storage.local;
storageArea.get(['activeCaptureTabId', 'currentStreamId']).then(data => {
  activeCaptureTabId = (data.activeCaptureTabId as number) || null;
  currentStreamId = (data.currentStreamId as string) || null;
  console.log('[Background] 🔄 State restored:', { activeCaptureTabId, currentStreamId });
});

// Allow content scripts to access chrome.storage.session
if (chrome.storage.session) {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch(err => console.error('[Background] Failed to set session access level:', err));
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function sendToOffscreen(message: any, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await chrome.runtime.sendMessage(message);
      return;
    } catch (err) {
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt)));
        continue;
      }
      console.error('[Background] Failed to reach offscreen:', (err as Error).message);
    }
  }
}

// ── Extension Icon Click ────────────────────────────────────────────────────

async function handleAction(tab: chrome.tabs.Tab) {
  if (!tab.id) return;
  console.log('[Background] 🖱️ Action triggered for tab:', tab.id);

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch (err) {
    console.log('[Background] 💉 UI not ready, injecting content script...');
    await injectContentScript(tab.id);
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id!, { type: 'TOGGLE_PANEL', show: true }).catch(() => {});
    }, 300);
  }

  if (activeCaptureTabId === tab.id && currentStreamId) {
    return;
  }

  if (activeCaptureTabId !== null && activeCaptureTabId !== tab.id) {
    stopAllCapture();
  }

  await ensureOffscreenDocument();

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

    if (!streamId) {
      console.error('[Background] ❌ getMediaStreamId returned null');
      return;
    }

    activeCaptureTabId = tab.id;
    currentStreamId = streamId;
    await storageArea.set({ activeCaptureTabId, currentStreamId });

    await sendToOffscreen({
      type: 'CONSUME_STREAM',
      streamId: streamId,
      tabId: tab.id
    });
  } catch (err) {
    console.error('[Background] ❌ TabCapture error:', err);
  }
}

chrome.action.onClicked.addListener(handleAction);

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-panel') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) handleAction(tab);
  }
});

// ── Offscreen Document ─────────────────────────────────────────────────────

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

async function ensureOffscreenDocument() {
  try {
    if (chrome.runtime.getContexts) {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
      });
      if (existingContexts.length > 0) return;
    }
  } catch (err) {}

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Capturing tab audio for real-time translation'
    });
  } catch (err) {}
}

async function closeOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    if (contexts.length > 0) await chrome.offscreen.closeDocument();
  } catch (err) {}
}

// ── Edge TTS Lifecycle ──────────────────────────────────────────────────────

const startEdgeTtsManager = async () => {
  await edgeManager.updateHeaders();
  setInterval(() => edgeManager.updateHeaders(), 60 * 1000);
};

// Initialize Network Monitor for Extractors
const networkMonitor = new NetworkMonitor(EXTRACTORS);
networkMonitor.init();

chrome.runtime.onInstalled.addListener(startEdgeTtsManager);
chrome.runtime.onStartup.addListener(startEdgeTtsManager);
startEdgeTtsManager();

// ── Tab Events ─────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeCaptureTabId) stopAllCapture();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === activeCaptureTabId) {
    if (changeInfo.status === 'loading' || changeInfo.url) {
      console.log('[Background] 🔄 Tab navigating or refreshing. Stopping translation...');
      sendToOffscreen({ type: 'STOP_TRANSLATION' }).catch(() => {});
      chrome.tabs.sendMessage(tabId, { type: 'FORCE_STOP_TRANSLATION' }).catch(() => {});
    }
    
    if (changeInfo.status === 'complete') {
      chrome.tabs.sendMessage(tabId, { type: 'CHECK_UI' }).catch(() => {
        injectContentScript(tabId);
      });
    }
  }
});

// ── Message Routing ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'STOP_CAPTURE':
      stopAllCapture();
      sendResponse({ success: true });
      return false;

    case 'GET_EDGE_TOKEN':
      sendResponse({ token: edgeManager.getToken() });
      return false;

    case 'GET_EDGE_VOICES':
      fetch('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4')
        .then(res => res.json())
        .then(data => sendResponse({ voices: data }))
        .catch(err => sendResponse({ voices: null, error: err.message }));
      return true; 

    case 'GET_CAPTURE_STATUS':
      sendResponse({ active: activeCaptureTabId !== null, tabId: activeCaptureTabId });
      return false;

    case 'START_TRANSLATION':
    case 'STOP_TRANSLATION':
    case 'PROCESS_SUBTITLES':
    case 'SPEAK_SUBTITLE':
    case 'TEST_TTS':
    case 'PRERENDER_SUBTITLES':
    case 'PLAY_PRERENDERED':
    case 'PAUSE_TTS':
    case 'RESUME_TTS':
    case 'RESET_TTS_DEDUP':
      ensureOffscreenDocument().then(() => {
        sendToOffscreen(message).then(() => sendResponse({ success: true }));
      });
      return true;

    case 'UPDATE_TRANSCRIPT':
    case 'UPDATE_TRANSCRIPT_ERROR':
    case 'UPDATE_TRANSCRIPT_STATUS':
    case 'TTS_STATE_CHANGED':
    case 'TTS_WORD_BOUNDARY':
    case 'PRERENDER_COMPLETE':
      if (activeCaptureTabId) {
        chrome.tabs.sendMessage(activeCaptureTabId, message).catch(() => {});
      }
      return false;

    case 'UI_OK':
        // Content script is healthy
        return false;

    default:
      return false;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────

async function injectContentScript(tabId: number) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'src/content/content-script.ts'
      ]
    });
  } catch (err) {}
}

function stopAllCapture() {
  activeCaptureTabId = null;
  currentStreamId = null;
  storageArea.remove(['activeCaptureTabId', 'currentStreamId']);
  chrome.runtime.sendMessage({ type: 'STOP_OFFSCREEN_CAPTURE' }).catch(() => {});
  closeOffscreenDocument();
}