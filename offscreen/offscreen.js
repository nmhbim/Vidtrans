// offscreen/offscreen.js
// Audio capture + STT/Translation pipeline — runs in hidden Offscreen Document

import { GroqClient } from '../lib/groq-api.js';
import { sleep, log, logError, getBestMimeType } from '../lib/utils.js';

// ── State ───────────────────────────────────────────────────────────────────

/** @type {MediaStream|null} */
let mediaStream = null;

/** @type {AudioContext|null} */
let audioContext = null;

/** @type {MediaRecorder|null} */
let mediaRecorder = null;

/** @type {GroqClient|null} */
let groqClient = null;

/** @type {string} */
let currentSourceLang = 'en-US';

/** @type {boolean} */
let isTranslating = false;

/** @type {string|null} */
let activeStreamId = null;

// ── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CONSUME_STREAM') {
    handleConsumeStream(msg.streamId, msg.tabId);
    sendResponse({ success: true });

  } else if (msg.type === 'START_TRANSLATION') {
    currentSourceLang = msg.sourceLang || 'en-US';
    startTranslation();
    sendResponse({ success: true });

  } else if (msg.type === 'STOP_TRANSLATION') {
    stopTranslation();
    sendResponse({ success: true });

  } else if (msg.type === 'STOP_OFFSCREEN_CAPTURE') {
    stopCapture();
  }

  return true;
});

// ── Audio Capture ────────────────────────────────────────────────────────────

/**
 * Handle streamId from background → start audio passthrough
 * @param {string} streamId
 * @param {number} tabId
 */
async function handleConsumeStream(streamId, tabId) {
  if (activeStreamId === streamId) {
    log('[Offscreen] StreamId already active, skipping');
    return; // Already capturing
  }

  // Stop any existing capture first
  if (mediaStream) {
    stopCapture();
  }

  try {
    log('[Offscreen] Requesting MediaStream with streamId:', streamId.substring(0, 20) + '...');

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    activeStreamId = streamId;
    log('[Offscreen] MediaStream obtained successfully');

    // Passthrough audio (keeps video playing while we record)
    audioContext = new AudioContext();
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(audioContext.destination);

    log('[Offscreen] Audio passthrough active — video will NOT be muted');

  } catch (err) {
    logError('[Offscreen] Failed to get MediaStream:', err.message);
    activeStreamId = null;
  }
}

// ── Translation Pipeline ─────────────────────────────────────────────────────

/**
 * Start the recording → STT → translate loop
 */
async function startTranslation() {
  if (!mediaStream) {
    logError('[Offscreen] No MediaStream — call CONSUME_STREAM first');
    sendError('Chưa có luồng âm thanh. Bật extension từ icon trước.');
    return;
  }

  if (isTranslating) {
    log('[Offscreen] Already translating, ignoring');
    return;
  }

  // Load API key from storage
  const state = await chrome.storage.local.get('vidtrans_groq_key');
  const apiKey = state.vidtrans_groq_key;

  if (!apiKey) {
    sendError('Chưa nhập Groq API Key trong cài đặt extension.');
    return;
  }

  try {
    groqClient = new GroqClient(apiKey);
  } catch (err) {
    sendError(`API Key không hợp lệ: ${err.message}`);
    return;
  }

  isTranslating = true;
  sendStatus('Đang phiên dịch...');
  log('[Offscreen] Translation started — beginning record loop');

  recordNextChunk();
}

/**
 * Stop translation and cleanup recorder
 */
function stopTranslation() {
  if (!isTranslating) return;

  isTranslating = false;
  sendStatus('Đã dừng phiên dịch');

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch (err) {
      // Ignore if already stopped
    }
  }

  mediaRecorder = null;
  groqClient = null;

  log('[Offscreen] Translation stopped');
}

/**
 * Record one audio chunk, then schedule the next
 */
function recordNextChunk() {
  if (!isTranslating || !mediaStream) return;

  const mimeType = getBestMimeType();
  const options = mimeType ? { mimeType } : {};

  try {
    mediaRecorder = new MediaRecorder(mediaStream, options);
  } catch (err) {
    logError('[Offscreen] MediaRecorder init failed:', err.message);
    // Fallback: try without mimeType
    mediaRecorder = new MediaRecorder(mediaStream);
  }

  /** @type {Blob[]} */
  let chunkBlobs = [];

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunkBlobs.push(event.data);
    }
  };

  mediaRecorder.onstop = async () => {
    if (!isTranslating) return;
    if (chunkBlobs.length === 0) {
      recordNextChunk();
      return;
    }

    // Combine all blobs from this chunk period
    const audioBlob = new Blob(chunkBlobs, { type: mimeType || 'audio/webm' });
    chunkBlobs = [];

    // Process async (don't wait — schedule next recording immediately)
    processAudioChunk(audioBlob).catch(err => {
      logError('[Offscreen] processAudioChunk error:', err.message);
    });

    // Schedule next chunk immediately
    recordNextChunk();
  };

  mediaRecorder.onerror = (event) => {
    logError('[Offscreen] MediaRecorder error:', event.error);
    stopTranslation();
  };

  // Start recording — auto-stop after 5 seconds
  mediaRecorder.start(5000); // timeslice=5000 triggers ondataavailable every 5s

  log(`[Offscreen] Recorder started (${mimeType || 'default'}, 5s chunks)`);
}

/**
 * STT → Translate → Send to UI
 * @param {Blob} audioBlob
 */
async function processAudioChunk(audioBlob) {
  if (!groqClient || !isTranslating) return;

  try {
    // 1. Speech-to-Text with Groq Whisper
    const originalText = await groqClient.transcribe(audioBlob);

    if (!originalText || originalText.trim().length < 2) {
      log('[Offscreen] Empty transcript, skipping');
      return;
    }

    log(`[Offscreen] STT: "${originalText}"`);

    // 2. Translate to Vietnamese
    const translatedText = await groqClient.translateWithRetry(originalText, currentSourceLang);

    if (!translatedText) {
      log('[Offscreen] Empty translation, skipping');
      return;
    }

    log(`[Offscreen] VI: "${translatedText}"`);

    // 3. Send to UI
    sendTranscript(originalText, translatedText);

  } catch (err) {
    logError('[Offscreen] Pipeline error:', err.message);

    if (err.message.includes('Invalid API Key')) {
      sendError('API Key không hợp lệ. Kiểm tra lại trong cài đặt.');
      stopTranslation();
    } else if (err.message.includes('429') || err.message.includes('rate limit')) {
      sendError('Groq rate limit — đợi một chút...');
      // Wait and try again with next chunk
    } else {
      sendError(`Lỗi: ${err.message}`);
    }
  }
}

// ── Message Helpers ─────────────────────────────────────────────────────────

/**
 * @param {string} original
 * @param {string} translated
 */
function sendTranscript(original, translated) {
  chrome.runtime.sendMessage({
    type: 'UPDATE_TRANSCRIPT',
    original,
    translated
  }).catch(() => {});
}

/**
 * @param {string} message
 * @param {boolean} [isError=false]
 */
function sendError(message, isError = true) {
  chrome.runtime.sendMessage({
    type: 'UPDATE_TRANSCRIPT_ERROR',
    message,
    isError
  }).catch(() => {});
}

/**
 * @param {string} message
 */
function sendStatus(message) {
  chrome.runtime.sendMessage({
    type: 'UPDATE_TRANSCRIPT_ERROR',
    message,
    isError: false
  }).catch(() => {});
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

/**
 * Full cleanup — stop everything, release resources
 */
function stopCapture() {
  stopTranslation();

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  activeStreamId = null;
  log('[Offscreen] Capture fully stopped');
}
