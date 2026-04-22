// offscreen/offscreen.js
// Audio capture + STT/Translation pipeline — runs in hidden Offscreen Document

import { GroqClient } from '../lib/groq-api.js';
import { NativeTTS } from '../lib/tts-engines/native-tts.js';
import { EdgeTTS } from '../lib/tts-engines/edge-tts.js';
// Utils now loaded via script tag in offscreen.html

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
// TTS Queue state
let ttsQueue = [];
let isPlayingTts = false;

/** @type {boolean} */
let isTranslating = false;
let translationContext = []; // Store last 3 translations for context
let subtitleTimeline = []; // { startMs, durationMs, text, translated }
let lastPlayedSubIndex = -1;

/** @type {number} */
let ttsRate = 1.0;

/** @type {string} */
let ttsVoice = 'vi-VN-HoaiMyNeural';

/** @type {string} */
let ttsEngine = 'edge'; // 'edge' or 'native'

/** @type {string|null} */
let activeStreamId = null;
let currentSubLang = null;

/** @type {HTMLAudioElement|null} */
let currentAudio = null;
/** @type {WebSocket|null} */
let currentWs = null;

// ── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  log('[Offscreen] 📥 Received message:', msg.type);
  if (msg.type === 'CONSUME_STREAM') {
    handleConsumeStream(msg.streamId, msg.tabId);
    sendResponse({ success: true });

  } else if (msg.type === 'START_TRANSLATION') {
    log('[Offscreen] ⚡ Starting translation (LIVE MODE)...');
    apiKey = msg.apiKey;
    targetLang = msg.targetLang || 'vi'; // Sync with content.js rename
    ttsRate = msg.ttsRate || 1.3;
    if (msg.ttsVoice) ttsVoice = msg.ttsVoice;
    if (msg.ttsEngine) ttsEngine = msg.ttsEngine;
    
    subtitleTimeline = []; 
    lastPlayedSubIndex = -1;
    
    startTranslation(apiKey); 
    sendResponse({ success: true });

  } else if (msg.type === 'PROCESS_SUBTITLES') {
    log('[Offscreen] ⚡ Processing subtitles (SUBTITLE MODE)...');
    currentSourceLang = msg.sourceLang || 'en-US';
    ttsRate = msg.ttsRate || 1.3;
    if (msg.ttsVoice) ttsVoice = msg.ttsVoice;
    if (msg.ttsEngine) ttsEngine = msg.ttsEngine;
    
    groqClient = new GroqClient(msg.apiKey);
    isTranslating = true;
    handleProcessSubtitles(msg.subtitles, msg.subLang);
    sendResponse({ success: true });

  } else if (msg.type === 'SYNC_TIME') {
    handleSyncTime(msg.currentTimeMs);

  } else if (['START_TRANSLATION', 'STOP_TRANSLATION', 'SPEAK_SUBTITLE', 'TEST_TTS'].includes(msg.type)) {
    log(`[Offscreen] ⚡ TTS Command: ${msg.type} | Engine: ${msg.ttsEngine} | Voice: ${msg.ttsVoice} | Rate: ${msg.ttsRate}`);
    
    if (msg.ttsRate) ttsRate = msg.ttsRate;
    if (msg.ttsVoice) ttsVoice = msg.ttsVoice;
    if (msg.ttsEngine) ttsEngine = msg.ttsEngine;
    
    if (msg.text && msg.text.trim()) {
      log(`[Offscreen] 📝 Text: "${msg.text.substring(0, 50)}..."`);
      addToTtsQueue(msg.text);
    }
    sendResponse({ success: true });


  } else if (msg.type === 'STOP_TRANSLATION') {
    log('[Offscreen] 🛑 Stopping translation...');
    stopTranslation();
    sendResponse({ success: true });

  } else if (msg.type === 'STOP_OFFSCREEN_CAPTURE') {
    log('[Offscreen] 🛑 Stopping all capture...');
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
async function handleConsumeStream(streamId, _tabId) {
  if (activeStreamId === streamId) {
    log('[Offscreen] StreamId already active, skipping');
    return; // Already capturing
  }

  // Stop any existing capture first
  if (mediaStream) {
    stopCapture();
  }

  try {
    log('[Offscreen] 🎙️ Requesting MediaStream with streamId:', streamId.substring(0, 20) + '...');
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
    log('[Offscreen] ✅ MediaStream obtained successfully');
    sendStatus('Sẵn sàng phiên dịch');

    // Passthrough audio (keeps video playing while we record)
    audioContext = new AudioContext();
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(audioContext.destination);

    log('[Offscreen] 🔊 Audio passthrough active');

  } catch (err) {
    logError('[Offscreen] ❌ Failed to get MediaStream:', err.message);
    sendError(`Lỗi âm thanh: ${err.message}`);
    activeStreamId = null;
  }
}

// ── Translation Pipeline ─────────────────────────────────────────────────────

/**
 * Start the recording → STT → translate loop
 * @param {string} [apiKeyFromMessage] - API Key provided in the message
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

    // Use API key from message (robust) or fallback to storage (if available)
    let apiKey = apiKeyFromMessage;

    if (!apiKey) {
      log('[Offscreen] 🔑 Key not in message, trying storage fallback...');
      try {
        if (chrome.storage) {
          const storageArea = chrome.storage.session || chrome.storage.local;
          const state = await storageArea.get('vidtrans_groq_key');
          apiKey = state.vidtrans_groq_key;
        }
      } catch (e) {
        logError('[Offscreen] Storage fallback failed:', e);
      }
    }

    if (!apiKey) {
      logError('[Offscreen] ❌ API Key not found');
      sendError('Chưa nhập Groq API Key hoặc lỗi truyền key.');
      return;
    }

    log('[Offscreen] ✅ API Key ready, initializing GroqClient');
    try {
      groqClient = new GroqClient(apiKey);
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

  if (!mimeType) {
    logError('[Offscreen] No supported MIME type for MediaRecorder');
    sendError('Trình duyệt không hỗ trợ ghi âm. Thử dùng Chrome.');
    return;
  }

  const options = { mimeType };

  try {
    mediaRecorder = new MediaRecorder(mediaStream, options);
  } catch (err) {
    logError('[Offscreen] MediaRecorder init failed:', err.message);
    sendError('Lỗi ghi âm. Trình duyệt có thể không hỗ trợ.');
    return;
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

  // Start recording
  mediaRecorder.start(); 
  log(`[Offscreen] 🎙️ Recorder started (5s chunk...)`);

  // Stop and process after interval
  setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  }, CHUNK_INTERVAL_MS);
}

/**
 * STT → Translate → Send to UI
 * @param {Blob} audioBlob
 */
/**
 * Check if the audio blob is essentially silence
 * @param {Blob} audioBlob 
 * @returns {Promise<boolean>}
 */
async function isSilence(audioBlob) {
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    // We need a temporary context to decode
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
    
    const channelData = audioBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < channelData.length; i++) {
      sum += Math.abs(channelData[i]);
    }
    const average = sum / channelData.length;
    
    // Close context to free memory
    tempCtx.close();

    log(`[Offscreen] 🔊 Audio energy level: ${(average * 100).toFixed(3)}%`);
    
    // Threshold: 0.005 (0.5%) is usually a good "is something being said" limit
    return average < 0.005;
  } catch (err) {
    logError('[Offscreen] Silence check error:', err);
    return false; // Assume not silence if check fails
  }
}

async function processAudioChunk(audioBlob) {
  if (!groqClient || !isTranslating) return;

  try {
    // 0. Silence detection (VAD)
    const silent = await isSilence(audioBlob);
    if (silent) {
      log('[Offscreen] 🤫 Silence detected, skipping AI processing');
      return;
    }

    log(`[Offscreen] 🧠 Processing audio chunk (${(audioBlob.size / 1024).toFixed(1)} KB)...`);
    
    // 1. Speech-to-Text with Groq Whisper
    const originalText = await groqClient.transcribe(audioBlob);

    if (!originalText || originalText.trim().length < 2) {
      log('[Offscreen] 🙊 No speech detected in chunk');
      return;
    }

    // --- Hallucination Filter ---
    const lowerText = originalText.toLowerCase().trim().replace(/[.,!?;]/g, '');
    const hallucinations = [
      'thank you', 'thanks for watching', 'please subscribe', 
      'subscribe to my channel', 'thanks for listening',
      'cảm ơn', 'cảm ơn bạn đã xem', 'hẹn gặp lại',
      'you', 'i', 'me', 'the', 'a', 'it', 'yeah', 'um', 'uh'
    ];
    
    // If the text is JUST one of these common hallucinations, skip it
    if (hallucinations.includes(lowerText)) {
      log('[Offscreen] 🚫 Hallucination filtered:', originalText);
      return;
    }

    log(`[Offscreen] 📝 STT: "${originalText}"`);

    // 2. Translate to Vietnamese with Context
    const contextStr = translationContext.length > 0 ? `\nContext (Last few sentences): ${translationContext.join(' | ')}` : '';
    const prompt = `Translate this speech to Vietnamese. Stay consistent with the provided context. Speak naturally.\n\n${contextStr}\n\nCurrent Speech: "${originalText}"`;
    
    const translatedText = await groqClient.translate(prompt);

    if (!translatedText) {
      log('[Offscreen] ❓ Translation empty, skipping');
      return;
    }

    log(`[Offscreen] 🇻🇳 VI: "${translatedText}"`);

    // Update context
    translationContext.push(translatedText);
    if (translationContext.length > 3) translationContext.shift();

    // 3. Send to UI
    chrome.runtime.sendMessage({
      type: 'UPDATE_TRANSCRIPT',
      original: originalText,
      translated: translatedText
    }).catch(() => {});

    // 4. Add to TTS Queue (only if not native, since content.js handles native directly)
    if (ttsEngine !== 'native') {
      addToTtsQueue(translatedText);
    }

  } catch (err) {
    logError('[Offscreen] ❌ Pipeline error:', err.message);
    // ... rest of error handling ...

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




const engines = {
  'native': new NativeTTS(),
  'edge': new EdgeTTS()
};

let currentEngine = null;

function stopCurrentTts() {
  if (currentEngine) {
    currentEngine.stop();
  }
  isPlayingTts = false;
}

function addToTtsQueue(text) {
  ttsQueue.push(text);
  if (!isPlayingTts) {
    playNextInTtsQueue();
  }
}

async function playNextInTtsQueue() {
  if (ttsQueue.length === 0) {
    isPlayingTts = false;
    if (isTranslating) {
      chrome.runtime.sendMessage({ type: 'TTS_STATE_CHANGED', playing: false }).catch(() => {});
    }
    return;
  }

  isPlayingTts = true;
  const text = ttsQueue.shift();

  try {
    // Determine engine to use from global ttsEngine variable (default 'edge')
    currentEngine = engines[ttsEngine] || engines['edge'];

    // Tell content script to duck volume
    chrome.runtime.sendMessage({ type: 'TTS_STATE_CHANGED', playing: true }).catch(() => {});

    log(`[Offscreen] 🔊 Speaking using ${currentEngine.name}: "${text.substring(0, 30)}..."`);
    
    await currentEngine.speak(text, ttsRate, ttsVoice);
    
    playNextInTtsQueue();

  } catch (err) {
    const errMsg = err?.message || 'Lỗi không xác định';
    logError(`[Offscreen] ❌ TTS Engine Error (${currentEngine.id}):`, errMsg);
    
    // Report to UI
    chrome.runtime.sendMessage({
      type: 'UPDATE_TRANSCRIPT_ERROR',
      message: `TTS Error: ${errMsg}`,
      isError: true
    }).catch(() => {});
    playNextInTtsQueue();
  }
}

/**
 * @param {string} text
 * @param {SpeechSynthesisVoice} voice
 */
function playNativeTts(text, voice) {
  return new Promise((resolve) => {
    const utt = new SpeechSynthesisUtterance(text);
    utt.voice = voice;
    utt.rate = ttsRate;
    utt.onend = () => resolve(true);
    utt.onerror = () => resolve(false);
    speechSynthesis.speak(utt);
  });
}

/**
 * Fallback to standard browser TTS if Edge TTS fails
 */
function fallbackToDefaultTTS(text) {
  log('[Offscreen] 🔄 Using browser default TTS fallback');
  
  // Ensure volume is ducked for fallback too
  chrome.runtime.sendMessage({ type: 'TTS_STATE_CHANGED', playing: true }).catch(() => {});

  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'vi-VN';
  utt.rate = ttsRate;

  // Try to find a matching voice (Male/Female)
  const voices = speechSynthesis.getVoices();
  const isMale = edgeTts.voice.toLowerCase().includes('nam');
  
  const targetVoice = voices.find(v => 
    v.lang.startsWith('vi') && 
    (isMale ? (v.name.toLowerCase().includes('male') || v.name.toLowerCase().includes('nam')) : true)
  );

  if (targetVoice) {
    log(`[Offscreen] 🎤 Selected fallback voice: ${targetVoice.name}`);
    utt.voice = targetVoice;
  }
  
  utt.onend = () => playNextInTtsQueue();
  utt.onerror = (e) => {
    logError('[Offscreen] ❌ Fallback TTS error:', e);
    playNextInTtsQueue();
  };
  
  speechSynthesis.speak(utt);
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
    type: 'UPDATE_TRANSCRIPT_STATUS',
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

// ── Monitoring ─────────────────────────────────────────────────────────────────

/**
 * Periodically check if recorder is supposed to be running but isn't
 */
function monitorRecorder() {
  if (isTranslating && (!mediaRecorder || mediaRecorder.state === 'inactive')) {
    logError('[Offscreen] Recorder stopped unexpectedly, restarting...');
    recordNextChunk();
  }
}

// Check every 10 seconds
setInterval(monitorRecorder, 10000);

// ── Subtitle Mode Helpers ─────────────────────────────────────────────────────

/**
 * Handle PROCESS_SUBTITLES message
 * @param {Array} subs 
 * @param {string} subLang
 */
async function handleProcessSubtitles(subs, subLang) {
  log(`[Offscreen] 📦 Processing ${subs.length} subtitles (Lang: ${subLang}) for translation...`);
  subtitleTimeline = subs;
  currentSubLang = subLang;
  lastPlayedSubIndex = -1;
  sendStatus(`Đã tải ${subs.length} phụ đề. Đang đồng bộ...`);
}

/**
 * Handle SYNC_TIME message from content script
 * @param {number} currentTimeMs 
 */
function handleSyncTime(currentTimeMs) {
  if (!isTranslating || subtitleTimeline.length === 0) return;

  // Find the current subtitle index based on video time
  const index = subtitleTimeline.findIndex(s => 
    currentTimeMs >= s.start && currentTimeMs <= (s.start + s.duration)
  );

  // Only process if it's a new subtitle
  if (index !== -1 && index !== lastPlayedSubIndex) {
    lastPlayedSubIndex = index;
    const sub = subtitleTimeline[index];
    processSubtitleItem(sub, index);
  }
}

/**
 * Process a single subtitle item: translate and queue TTS
 * @param {object} sub 
 * @param {number} index 
 */
async function processSubtitleItem(sub, index) {
  if (!isTranslating) return;

  try {
    log(`[Offscreen] 📝 Sync: Subtitle ${index} -> "${sub.text}"`);
    
    // 1. Translate (if not already in Vietnamese)
    let translated = sub.translated;
    
    if (!translated) {
      const isVietnamese = currentSubLang && (currentSubLang.startsWith('vi') || currentSubLang.includes('vietnamese'));
      
      if (isVietnamese) {
        log('[Offscreen] 🇻🇳 Subtitle already in Vietnamese, skipping translation.');
        translated = sub.text;
      } else if (groqClient) {
        translated = await groqClient.translateWithRetry(sub.text, currentSourceLang);
      }
      
      sub.translated = translated; // Cache it
    }

    if (!translated || !isTranslating) return;

    // 2. Update UI
    sendTranscript(sub.text, translated);

    // 3. Play TTS
    addToTtsQueue(translated);

  } catch (err) {
    logError(`[Offscreen] ❌ Subtitle ${index} error:`, err.message);
  }
}
