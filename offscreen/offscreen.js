// offscreen/offscreen.js
// Audio capture + STT/Translation pipeline — runs in hidden Offscreen Document

import { GroqClient } from '../lib/groq-api.js';
import { TTSController } from '../lib/tts-controller.js';
// Utils + Constants loaded via script tags in offscreen.html

const CHUNK_INTERVAL_MS = 6000; // Better context with 6s chunks

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

/** @type {string} */
let apiKey = '';

/** @type {string} */
let targetLang = 'vi';

/** @type {boolean} */
let isTranslating = false;

/** @type {string[]} */
let translationContext = []; // Last 3 translations for context

/** @type {string|null} */
let activeStreamId = null;

/** @type {string|null} */
let currentSubLang = null;

// ── Subtitle Mode State ─────────────────────────────────────────────────────

let subtitleTimeline = []; // { start, duration, text, translated }
let lastPlayedSubIndex = -1;

// ── TTS Controller (single source of truth) ─────────────────────────────────

const ttsController = new TTSController({
  onPlaybackStart: () => {
    log('[Offscreen] 🦆 Ducking started');
    sendMessage({ type: 'TTS_STATE_CHANGED', playing: true });
  },
  onPlaybackEnd: () => {
    log('[Offscreen] 🦆 Ducking ended');
    sendMessage({ type: 'TTS_STATE_CHANGED', playing: false });
  },
  onError: (errMsg) => {
    sendMessage({
      type: 'UPDATE_TRANSCRIPT_ERROR',
      message: `TTS Error: ${errMsg}`,
      isError: true
    });
  }
});

// Wire up word boundary tracking (Edge TTS)
ttsController.setWordBoundaryListener((wb, audio) => {
  sendMessage({
    type: 'TTS_WORD_BOUNDARY',
    word: wb.text,
    offsetMs: wb.offsetMs,
    durationMs: wb.durationMs,
    textOffset: wb.textOffset,
    textLength: wb.textLength,
    // Full text being spoken — needed for subtitle pagination
    fullText: ttsController.currentText,
    // Current audio playback position for sync
    audioTimeMs: audio ? audio.currentTime * 1000 : 0,
  });
});

// ── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  log('[Offscreen] 📥 Received:', msg.type);

  switch (msg.type) {
    case 'CONSUME_STREAM':
      handleConsumeStream(msg.streamId, msg.tabId);
      sendResponse({ success: true });
      break;

    case 'START_TRANSLATION':
      log('[Offscreen] ⚡ Starting translation (LIVE MODE)...');
      apiKey = msg.apiKey;
      targetLang = msg.targetLang || 'vi';
      syncTtsSettings(msg);
      subtitleTimeline = [];
      lastPlayedSubIndex = -1;
      startTranslation(apiKey);
      sendResponse({ success: true });
      break;

    case 'STOP_TRANSLATION':
      log('[Offscreen] 🛑 Stopping translation...');
      stopTranslation();
      sendResponse({ success: true });
      break;

    case 'PROCESS_SUBTITLES':
      log('[Offscreen] ⚡ Processing subtitles (SUBTITLE MODE)...');
      currentSourceLang = msg.sourceLang || 'en-US';
      if (msg.targetLang) targetLang = msg.targetLang;
      syncTtsSettings(msg);
      groqClient = new GroqClient(msg.apiKey, targetLang);
      isTranslating = true;
      handleProcessSubtitles(msg.subtitles, msg.subLang);
      sendResponse({ success: true });
      break;

    case 'SYNC_TIME':
      handleSyncTime(msg.currentTimeMs);
      break;

    case 'SPEAK_SUBTITLE':
    case 'TEST_TTS':
      syncTtsSettings(msg);
      if (msg.text?.trim()) {
        log(`[Offscreen] 📝 TTS: "${msg.text.substring(0, 50)}..."`);
        ttsController.enqueue(msg.text);
      }
      sendResponse({ success: true });
      break;

    // ── Pre-render for subtitle mode ──────────────────────────────────────
    case 'PRERENDER_SUBTITLES':
      syncTtsSettings(msg);
      if (msg.texts?.length > 0) {
        log(`[Offscreen] 📦 Pre-rendering ${msg.texts.length} subtitles...`);
        ttsController.prerenderBatch(msg.texts).then(count => {
          log(`[Offscreen] ✅ Pre-rendered ${count}/${msg.texts.length}`);
          sendMessage({
            type: 'PRERENDER_COMPLETE',
            count,
            total: msg.texts.length,
            stats: ttsController.getCacheStats()
          });
        });
      }
      sendResponse({ success: true });
      break;

    case 'PLAY_PRERENDERED':
      syncTtsSettings(msg);
      if (msg.text?.trim()) {
        log(`[Offscreen] ⚡ Play pre-rendered: "${msg.text.substring(0, 50)}..."`);
        ttsController.playPrerendered(msg.text);
      }
      sendResponse({ success: true });
      break;

    case 'STOP_OFFSCREEN_CAPTURE':
      log('[Offscreen] 🛑 Stopping all capture...');
      stopCapture();
      break;
  }

  return true;
});

// ── TTS Settings Helper ─────────────────────────────────────────────────────

/**
 * Sync TTS settings from a message to the controller.
 * @param {Object} msg
 */
function syncTtsSettings(msg) {
  if (msg.ttsRate) ttsController.setRate(msg.ttsRate);
  if (msg.ttsVoice) ttsController.setVoice(msg.ttsVoice);
  if (msg.ttsEngine) ttsController.setEngine(msg.ttsEngine);
}

// ── Audio Capture ────────────────────────────────────────────────────────────

/**
 * Handle streamId from background → start audio passthrough
 * @param {string} streamId
 * @param {number} tabId
 */
async function handleConsumeStream(streamId, _tabId) {
  if (activeStreamId === streamId) {
    log('[Offscreen] StreamId already active, skipping');
    return;
  }

  if (mediaStream) {
    stopCapture();
  }

  try {
    log('[Offscreen] 🎙️ Requesting MediaStream...');
    sendStatus('Đang khởi tạo luồng âm thanh...');

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
    log('[Offscreen] ✅ MediaStream obtained');
    sendStatus('Sẵn sàng phiên dịch');

    // Passthrough audio so the video keeps playing
    audioContext = new AudioContext();
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(audioContext.destination);

    log('[Offscreen] 🔊 Audio passthrough active');
  } catch (err) {
    logError('[Offscreen] ❌ MediaStream failed:', err.message);
    sendError(`Lỗi âm thanh: ${err.message}`);
    activeStreamId = null;
  }
}

// ── Translation Pipeline ─────────────────────────────────────────────────────

/**
 * Start the recording → STT → translate loop
 * @param {string} [apiKeyFromMessage]
 */
async function startTranslation(apiKeyFromMessage) {
  log('[Offscreen] 🚀 Entering startTranslation...');

  try {
    if (!mediaStream) {
      logError('[Offscreen] ❌ No MediaStream — call CONSUME_STREAM first');
      sendError('Chưa có luồng âm thanh. Bật extension từ icon trước.');
      return;
    }

    if (isTranslating) {
      log('[Offscreen] ℹ️ Already translating, ignoring');
      return;
    }

    // Resolve API key
    let key = apiKeyFromMessage;
    if (!key) {
      log('[Offscreen] 🔑 Key not in message, trying storage fallback...');
      try {
        if (chrome.storage) {
          const storageArea = chrome.storage.session || chrome.storage.local;
          const state = await storageArea.get('vidtrans_groq_key');
          key = state.vidtrans_groq_key;
        }
      } catch (e) {
        logError('[Offscreen] Storage fallback failed:', e);
      }
    }

    if (!key) {
      logError('[Offscreen] ❌ API Key not found');
      sendError('Chưa nhập Groq API Key hoặc lỗi truyền key.');
      return;
    }

    log('[Offscreen] ✅ API Key ready, initializing GroqClient');
    try {
      groqClient = new GroqClient(key, targetLang);
    } catch (err) {
      sendError(`API Key không hợp lệ: ${err.message}`);
      return;
    }

    isTranslating = true;
    sendStatus('Đang phiên dịch...');
    log('[Offscreen] ✅ Translation loop starting...');
    recordNextChunk();
  } catch (err) {
    logError('[Offscreen] ❌ startTranslation crash:', err.message);
    sendError(`Lỗi hệ thống: ${err.message}`);
  }
}

/**
 * Stop translation and clean up.
 */
function stopTranslation() {
  // ⚡ ALWAYS stop TTS — even if isTranslating is false.
  // In subtitle pre-render mode, PLAY_PRERENDERED runs without
  // setting isTranslating, so we must stop TTS unconditionally.
  ttsController.stop();

  if (!isTranslating) {
    log('[Offscreen] TTS stopped (was not translating)');
    return;
  }

  isTranslating = false;
  sendStatus('Đã dừng phiên dịch');

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (err) {}
  }
  mediaRecorder = null;
  groqClient = null;
  translationContext = [];

  log('[Offscreen] Translation stopped (cache preserved)');
}

// ── Audio Recording ──────────────────────────────────────────────────────────

/**
 * Record one audio chunk, then schedule the next.
 */
function recordNextChunk() {
  if (!isTranslating || !mediaStream) return;

  const mimeType = getBestMimeType();
  if (!mimeType) {
    logError('[Offscreen] No supported MIME type');
    sendError('Trình duyệt không hỗ trợ ghi âm. Thử dùng Chrome.');
    return;
  }

  try {
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
  } catch (err) {
    logError('[Offscreen] MediaRecorder init failed:', err.message);
    sendError('Lỗi ghi âm. Trình duyệt có thể không hỗ trợ.');
    return;
  }

  /** @type {Blob[]} */
  let chunkBlobs = [];

  mediaRecorder.ondataavailable = (event) => {
    if (event.data?.size > 0) {
      chunkBlobs.push(event.data);
    }
  };

  mediaRecorder.onstop = async () => {
    if (!isTranslating) return;
    if (chunkBlobs.length === 0) { recordNextChunk(); return; }

    const audioBlob = new Blob(chunkBlobs, { type: mimeType });
    chunkBlobs = [];

    // Process async, don't block next recording
    processAudioChunk(audioBlob).catch(err => {
      logError('[Offscreen] processAudioChunk error:', err.message);
    });

    recordNextChunk();
  };

  mediaRecorder.onerror = (event) => {
    logError('[Offscreen] MediaRecorder error:', event.error);
    stopTranslation();
  };

  mediaRecorder.start();
  log(`[Offscreen] 🎙️ Recorder started (${CHUNK_INTERVAL_MS / 1000}s chunk...)`);

  setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  }, CHUNK_INTERVAL_MS);
}

// ── Audio Processing ────────────────────────────────────────────────────────

/**
 * Check if audio blob is essentially silence.
 * @param {Blob} audioBlob
 * @returns {Promise<boolean>}
 */
async function isSilence(audioBlob) {
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

    const channelData = audioBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < channelData.length; i++) {
      sum += Math.abs(channelData[i]);
    }
    const average = sum / channelData.length;

    tempCtx.close();
    log(`[Offscreen] 🔊 Audio energy: ${(average * 100).toFixed(3)}%`);
    return average < 0.005;
  } catch (err) {
    logError('[Offscreen] Silence check error:', err);
    return false;
  }
}

/**
 * STT → Translate → Dispatch to UI + TTS
 * @param {Blob} audioBlob
 */
async function processAudioChunk(audioBlob) {
  if (!groqClient || !isTranslating) return;

  try {
    // 0. Silence detection
    if (await isSilence(audioBlob)) {
      log('[Offscreen] 🤫 Silence detected, skipping');
      return;
    }

    log(`[Offscreen] 🧠 Processing chunk (${(audioBlob.size / 1024).toFixed(1)} KB)...`);

    // 1. STT
    const originalText = await groqClient.transcribe(audioBlob);
    if (!originalText || originalText.trim().length < 2) {
      log('[Offscreen] 🙊 No speech detected');
      return;
    }

    // 2. Hallucination filter
    const lowerText = originalText.toLowerCase().trim().replace(/[.,!?;]/g, '');
    const hallucinations = [
      'thank you', 'thanks for watching', 'please subscribe',
      'subscribe to my channel', 'thanks for listening',
      'cảm ơn', 'cảm ơn bạn đã xem', 'hẹn gặp lại',
      'you', 'i', 'me', 'the', 'a', 'it', 'yeah', 'um', 'uh'
    ];

    if (hallucinations.includes(lowerText)) {
      log('[Offscreen] 🚫 Hallucination filtered:', originalText);
      return;
    }

    log(`[Offscreen] 📝 STT: "${originalText}"`);

    // 3. Translate
    const contextStr = translationContext.length > 0
      ? `\nContext (Last few sentences): ${translationContext.join(' | ')}`
      : '';
    const prompt = `Translate this speech to language code: ${targetLang}. Stay consistent with the provided context. Speak naturally.\n\n${contextStr}\n\nCurrent Speech: "${originalText}"`;

    const translatedText = await groqClient.translate(prompt);
    if (!translatedText) {
      log('[Offscreen] ❓ Translation empty, skipping');
      return;
    }

    log(`[Offscreen] 🌐 [${targetLang.toUpperCase()}]: "${translatedText}"`);

    // Update context window
    translationContext.push(translatedText);
    if (translationContext.length > 3) translationContext.shift();

    // 4. Send to UI
    sendMessage({
      type: 'UPDATE_TRANSCRIPT',
      original: originalText,
      translated: translatedText
    });

    // 5. Queue TTS (Edge engine plays here; Native TTS plays in content.js)
    if (ttsController.engineId !== 'native') {
      ttsController.enqueue(translatedText);
    }

  } catch (err) {
    logError('[Offscreen] ❌ Pipeline error:', err.message);

    if (err.message.includes('Invalid API Key')) {
      sendError('API Key không hợp lệ. Kiểm tra lại trong cài đặt.');
      stopTranslation();
    } else if (err.message.includes('429') || err.message.includes('rate limit')) {
      sendError('Groq rate limit — đợi một chút...');
    } else {
      sendError(`Lỗi: ${err.message}`);
    }
  }
}

// ── Subtitle Mode ───────────────────────────────────────────────────────────

/**
 * Handle PROCESS_SUBTITLES message.
 * @param {Array} subs
 * @param {string} subLang
 */
async function handleProcessSubtitles(subs, subLang) {
  log(`[Offscreen] 📦 Processing ${subs.length} subtitles (Lang: ${subLang})...`);
  subtitleTimeline = subs;
  currentSubLang = subLang;
  lastPlayedSubIndex = -1;
  sendStatus(`Đã tải ${subs.length} phụ đề. Đang đồng bộ...`);
}

/**
 * Handle SYNC_TIME message — find current subtitle and process it.
 * @param {number} currentTimeMs
 */
function handleSyncTime(currentTimeMs) {
  if (!isTranslating || subtitleTimeline.length === 0) return;

  const index = subtitleTimeline.findIndex(s =>
    currentTimeMs >= s.start && currentTimeMs <= (s.start + s.duration)
  );

  if (index !== -1 && index !== lastPlayedSubIndex) {
    lastPlayedSubIndex = index;
    processSubtitleItem(subtitleTimeline[index], index);
  }
}

/**
 * Process a single subtitle: translate if needed → update UI → queue TTS.
 * @param {Object} sub
 * @param {number} index
 */
async function processSubtitleItem(sub, index) {
  if (!isTranslating) return;

  try {
    log(`[Offscreen] 📝 Subtitle ${index}: "${sub.text}"`);

    let translated = sub.translated;

    if (!translated) {
      const isTargetLang = currentSubLang &&
        (currentSubLang.startsWith(targetLang) || currentSubLang.toLowerCase().includes(targetLang));

      if (isTargetLang) {
        translated = sub.text;
      } else if (groqClient) {
        translated = await groqClient.translateWithRetry(sub.text, currentSourceLang);
      }

      sub.translated = translated; // Cache
    }

    if (!translated || !isTranslating) return;

    // Update UI
    sendMessage({
      type: 'UPDATE_TRANSCRIPT',
      original: sub.text,
      translated
    });

    // Queue TTS
    ttsController.enqueue(translated);
  } catch (err) {
    logError(`[Offscreen] ❌ Subtitle ${index} error:`, err.message);
  }
}

// ── Message Helpers ─────────────────────────────────────────────────────────

function sendMessage(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function sendError(message) {
  sendMessage({ type: 'UPDATE_TRANSCRIPT_ERROR', message, isError: true });
}

function sendStatus(message) {
  sendMessage({ type: 'UPDATE_TRANSCRIPT_STATUS', message, isError: false });
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

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

// ── Health Monitor ──────────────────────────────────────────────────────────

setInterval(() => {
  if (isTranslating && (!mediaRecorder || mediaRecorder.state === 'inactive')) {
    logError('[Offscreen] Recorder stopped unexpectedly, restarting...');
    recordNextChunk();
  }
}, 10000);
