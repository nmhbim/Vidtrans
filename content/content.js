// content/content.js
// Floating UI Panel + Subtitle Overlay + Audio Ducking + TTS
(async function () {
  'use strict';

  if (window.__vidtrans_injected__) {
    console.log('[VidTrans] ℹ️ Script already injected, checking UI...');
    // If already injected, we still want to ensure the panel is visible if requested
    // but we don't want to re-run the entire initialization if possible.
  }
  window.__vidtrans_injected__ = true;
  console.log('[VidTrans] 🚀 Content script initializing...');

  // ── Storage Keys (from lib/constants.js) ────────────────────────────────────
  const SK = window.STORAGE_KEYS || {};
  const API_KEY_STORAGE = SK.API_KEY || 'vidtrans_groq_key';
  const SOURCE_LANG_STORAGE = SK.SOURCE_LANG || 'vidtrans_source_lang';
  const PANEL_POS_STORAGE = SK.PANEL_POS || 'vidtrans_panel_pos';
  const TTS_RATE_STORAGE = SK.TTS_RATE || 'vidtrans_tts_rate';
  const TTS_VOICE_STORAGE = SK.TTS_VOICE || 'vidtrans_tts_voice';
  const TTS_ENGINE_STORAGE = SK.TTS_ENGINE || 'vidtrans_tts_engine';
  const SUBTITLE_POS_STORAGE = SK.SUBTITLE_POS || 'vidtrans_subtitle_pos';

  // ── Load State ─────────────────────────────────────────────────────────────
  let apiKey = '';
  let targetLang = 'vi';  // Language user wants to hear (was: sourceLang)
  let ttsRate = 1.3;
  let ttsVoice = '';
  let ttsEngine = 'edge';
  let panelPos = { right: '20px', top: '20px' };
  let subtitlePos = { left: '50%', bottom: '80px' };

  try {
    const state = await chrome.storage.local.get([API_KEY_STORAGE, SOURCE_LANG_STORAGE, PANEL_POS_STORAGE, TTS_RATE_STORAGE, TTS_VOICE_STORAGE, TTS_ENGINE_STORAGE]);

    apiKey = state[API_KEY_STORAGE] || '';
    targetLang = state[SOURCE_LANG_STORAGE] || 'vi';
    ttsRate = state[TTS_RATE_STORAGE] !== undefined ? state[TTS_RATE_STORAGE] : 1.3;
    ttsVoice = state[TTS_VOICE_STORAGE] || '';
    ttsEngine = state[TTS_ENGINE_STORAGE] || 'edge';
    panelPos = state[PANEL_POS_STORAGE] || { right: '20px', top: '20px' };
    subtitlePos = state[SUBTITLE_POS_STORAGE] || { left: '50%', bottom: '80px' };
  } catch (err) {
    console.error('[VidTrans] Failed to load state (context might be invalidated):', err);
    // Continue with defaults if possible, but some APIs might be unavailable
  }

  // ── Audio Ducking ──────────────────────────────────────────────────────────
  /** @type {Map<HTMLVideoElement, number>} */
  const videoVolumeMap = new Map();
  let duckRefCount = 0;

  function duckVideoVolume() {
    duckRefCount++;
    console.log('[VidTrans] 🦆 Ducking requested, refCount:', duckRefCount);

    document.querySelectorAll('video').forEach(v => {
      if (!videoVolumeMap.has(v)) {
        videoVolumeMap.set(v, v.volume);
      }
      // Target 10% of original volume, minimum 0.05
      v.volume = Math.max(v.volume * 0.3, 0.05);
    });
  }

  function restoreVideoVolume() {
    duckRefCount = Math.max(0, duckRefCount - 1);
    console.log('[VidTrans] 🦆 Restore requested, refCount:', duckRefCount);

    if (duckRefCount === 0) {
      videoVolumeMap.forEach((origVol, v) => {
        try {
          if (v && !v.paused && !v.ended) {
            v.volume = origVol;
          }
        } catch (e) { }
      });
      videoVolumeMap.clear();
    }
  }


  // ── Create Container ────────────────────────────────────────────────────────
  let container = document.getElementById('vidtrans-root');
  if (!container) {
    container = document.createElement('div');
    container.id = 'vidtrans-root';
    Object.assign(container.style, {
      position: 'fixed',
      right: panelPos.right,
      top: panelPos.top,
      zIndex: '2147483647',
      display: 'none', // Hidden by default until toggled
    });
    document.body.appendChild(container);
    // Ensure styles are updated (in case they changed)
    container.style.right = panelPos.right;
    container.style.top = panelPos.top;
    // Don't set display: 'none' here if it's already block, 
    // especially if we just set it to block in the re-injection check above.
    if (container.style.display !== 'block') {
      container.style.display = 'none';
    }
  }

  // Shadow DOM for CSS isolation
  let shadow = container.shadowRoot;
  if (!shadow) {
    shadow = container.attachShadow({ mode: 'open' });
  } else {
    // Clear existing content to re-initialize UI fresh (necessary if extension reloaded)
    shadow.innerHTML = '';
  }

  // ── Panel HTML ─────────────────────────────────────────────────────────────
  const html = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');

      :host {
        --bg-color: rgba(15, 23, 42, 0.88);
        --surface-color: rgba(30, 41, 59, 0.9);
        --primary-color: #3b82f6;
        --primary-hover: #2563eb;
        --success-color: #10b981;
        --warning-color: #f59e0b;
        --danger-color: #ef4444;
        --text-primary: #f8fafc;
        --text-secondary: #94a3b8;
        --border-color: rgba(51, 65, 85, 0.6);
        font-family: 'Inter', system-ui, sans-serif;
      }

      * { box-sizing: border-box; margin: 0; padding: 0; }

      .panel {
        width: 320px;
        background-color: var(--bg-color);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid var(--border-color);
        border-radius: 16px;
        color: var(--text-primary);
        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        overflow: hidden;
      }

      .header {
        padding: 14px 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--border-color);
        cursor: move;
        background: linear-gradient(180deg, rgba(30,41,59,0.5) 0%, rgba(15,23,42,0) 100%);
        user-select: none;
      }

      .header h1 {
        font-size: 16px;
        font-weight: 600;
        background: linear-gradient(135deg, #60a5fa, #3b82f6);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .header-controls { display: flex; gap: 6px; }

      .icon-btn {
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 16px;
        transition: color 0.2s, background 0.2s;
        padding: 4px 6px;
        border-radius: 6px;
      }

      .icon-btn:hover {
        color: var(--text-primary);
        background: rgba(255,255,255,0.1);
      }

      .settings-panel {
        display: none;
        padding: 14px 16px;
        background: rgba(0,0,0,0.2);
        border-bottom: 1px solid var(--border-color);
      }

      .settings-panel.active { display: block; }

      .content { padding: 14px 16px; }

      .form-group { margin-bottom: 10px; }

      .form-group label {
        display: block;
        font-size: 11px;
        margin-bottom: 5px;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .form-group select,
      .form-group input {
        width: 100%;
        padding: 8px 12px;
        border-radius: 8px;
        background: rgba(0,0,0,0.3);
        border: 1px solid var(--border-color);
        color: white;
        font-size: 13px;
        outline: none;
        transition: border-color 0.2s;
      }

      .form-group select:focus,
      .form-group input:focus {
        border-color: var(--primary-color);
      }

      #controls {
        padding: 12px 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .speed-control {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 8px 0;
      }

      .speed-control label {
        font-size: 11px;
        color: var(--text-secondary);
        white-space: nowrap;
        text-transform: uppercase;
      }

      .speed-control input[type="range"] {
        flex: 1;
        cursor: pointer;
      }

      #speed-val {
        font-weight: bold;
        color: var(--primary-color);
        min-width: 25px;
        text-align: right;
      }

      .toggle-btn {
        width: 100%;
        padding: 11px;
        border: none;
        border-radius: 8px;
        background-color: var(--primary-color);
        color: white;
        font-weight: 600;
        font-size: 14px;
        cursor: pointer;
        transition: background 0.2s, transform 0.1s;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      }

      .toggle-btn:hover:not(:disabled) {
        background-color: var(--primary-hover);
      }

      .toggle-btn:active:not(:disabled) {
        transform: scale(0.98);
      }

      .toggle-btn:disabled {
        background: var(--border-color);
        color: var(--text-secondary);
        cursor: not-allowed;
        box-shadow: none;
      }

      .toggle-btn.active {
        background-color: var(--warning-color);
      }

      .status-bar {
        margin-top: 8px;
        padding: 8px 10px;
        border-radius: 6px;
        font-size: 11px;
        background: rgba(0,0,0,0.3);
        color: var(--text-secondary);
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-secondary);
        flex-shrink: 0;
      }

      .status-dot.active { background: var(--success-color); animation: pulse 1.5s infinite; }
      .status-dot.error { background: var(--danger-color); }
      .status-dot.warning { background: var(--warning-color); }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      .transcript-box {
        margin-top: 10px;
        max-height: 120px;
        overflow-y: auto;
        background: rgba(0,0,0,0.3);
        border-radius: 8px;
        padding: 10px;
        font-size: 13px;
        border: 1px solid var(--border-color);
        line-height: 1.5;
        color: #cbd5e1;
      }

      .transcript-box::-webkit-scrollbar { width: 5px; }
      .transcript-box::-webkit-scrollbar-track { background: transparent; }
      .transcript-box::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.15);
        border-radius: 4px;
      }

      .transcript-item {
        margin-bottom: 8px;
        padding-bottom: 8px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        animation: fadeIn 0.3s ease-out;
      }

      .transcript-item:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }

      .transcript-vi {
        color: #fff;
        font-size: 14px;
        font-weight: 500;
        display: block;
      }

      .transcript-en {
        color: #64748b;
        font-size: 11px;
        display: block;
        margin-top: 2px;
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
    </style>

    <div class="panel" id="panel">
      <div class="header" id="drag-handle">
        <h1>VidTrans</h1>
        <div class="header-controls">
          <button class="icon-btn" id="settings-btn" title="Cài đặt">⚙️</button>
          <button class="icon-btn" id="minimize-btn" title="Thu nhỏ">─</button>
          <button class="icon-btn" id="close-btn" title="Đóng">✕</button>
        </div>
      </div>

      <div class="settings-panel" id="settings-panel">
        <div class="form-group">
          <label>Groq API Key</label>
          <input type="password" id="api-key" value="${apiKey}" placeholder="gsk_..." />
        </div>
        <button class="icon-btn" id="test-tts-btn" style="width: 100%; background: rgba(59, 130, 246, 0.1); color: var(--primary-color); border: 1px solid var(--primary-color); padding: 8px; border-radius: 8px; font-size: 12px; font-weight: 600; margin-top: 5px;">
          🔊 TEST GIỌNG ĐỌC
        </button>
      </div>

      <div class="content">
        <div class="form-group">
          <label>Ngôn ngữ muốn nghe</label>
          <select id="source-lang">
            <option value="vi" ${targetLang === 'vi' ? 'selected' : ''}>Tiếng Việt</option>
            <option value="en" ${targetLang === 'en' ? 'selected' : ''}>English</option>
            <option value="zh" ${targetLang === 'zh' ? 'selected' : ''}>中文 (Chinese)</option>
            <option value="ja" ${targetLang === 'ja' ? 'selected' : ''}>日本語 (Japanese)</option>
            <option value="ko" ${targetLang === 'ko' ? 'selected' : ''}>한국어 (Korean)</option>
            <option value="fr" ${targetLang === 'fr' ? 'selected' : ''}>Français (French)</option>
            <option value="de" ${targetLang === 'de' ? 'selected' : ''}>Deutsch (German)</option>
            <option value="es" ${targetLang === 'es' ? 'selected' : ''}>Español (Spanish)</option>
            <option value="ru" ${targetLang === 'ru' ? 'selected' : ''}>Русский (Russian)</option>
            <option value="it" ${targetLang === 'it' ? 'selected' : ''}>Italiano (Italian)</option>
            <option value="pt" ${targetLang === 'pt' ? 'selected' : ''}>Português (Portuguese)</option>
            <option value="th" ${targetLang === 'th' ? 'selected' : ''}>ไทย (Thai)</option>
            <option value="id" ${targetLang === 'id' ? 'selected' : ''}>Bahasa Indonesia</option>
            <option value="ms" ${targetLang === 'ms' ? 'selected' : ''}>Bahasa Melayu</option>
            <option value="tl" ${targetLang === 'tl' ? 'selected' : ''}>Filipino</option>
            <option value="hi" ${targetLang === 'hi' ? 'selected' : ''}>हिन्दी (Hindi)</option>
            <option value="ar" ${targetLang === 'ar' ? 'selected' : ''}>العربية (Arabic)</option>
            <option value="tr" ${targetLang === 'tr' ? 'selected' : ''}>Türkçe (Turkish)</option>
            <option value="nl" ${targetLang === 'nl' ? 'selected' : ''}>Nederlands (Dutch)</option>
            <option value="pl" ${targetLang === 'pl' ? 'selected' : ''}>Polski (Polish)</option>
            <option value="sv" ${targetLang === 'sv' ? 'selected' : ''}>Svenska (Swedish)</option>
            <option value="da" ${targetLang === 'da' ? 'selected' : ''}>Dansk (Danish)</option>
            <option value="fi" ${targetLang === 'fi' ? 'selected' : ''}>Suomi (Finnish)</option>
            <option value="el" ${targetLang === 'el' ? 'selected' : ''}>Ελληνικά (Greek)</option>
            <option value="cs" ${targetLang === 'cs' ? 'selected' : ''}>Čeština (Czech)</option>
            <option value="hu" ${targetLang === 'hu' ? 'selected' : ''}>Magyar (Hungarian)</option>
            <option value="ro" ${targetLang === 'ro' ? 'selected' : ''}>Română (Romanian)</option>
            <option value="uk" ${targetLang === 'uk' ? 'selected' : ''}>Українська (Ukrainian)</option>
          </select>
        </div>

        <button class="toggle-btn" id="toggle-btn" ${!apiKey ? 'disabled' : ''}>
          ${!apiKey ? '🔒 Cần API Key' : '▶ BẬT DỊCH'}
        </button>

        <div class="speed-control">
          <label>Tốc độ: <span id="speed-val">${ttsRate.toFixed(1)}</span>x</label>
          <input type="range" id="tts-speed" min="0.5" max="2.0" step="0.1" value="${ttsRate}">
        </div>

        <div class="form-group" style="margin-top: 8px;">
          <label>Engine Đọc (TTS)</label>
          <select id="tts-engine">
            <option value="edge" ${ttsEngine === 'edge' ? 'selected' : ''}>Microsoft Edge (Online)</option>
            <option value="native" ${ttsEngine === 'native' ? 'selected' : ''}>Trình duyệt (Offline)</option>
          </select>
        </div>

        <div class="form-group" style="margin-top: 8px;">
          <label>Giọng đọc</label>

          <select id="tts-voice">
            <!-- Populated dynamically -->
          </select>
        </div>

        <div class="status-bar" id="status-bar">
          <span class="status-dot" id="status-dot"></span>
          <span id="status-text">Sẵn sàng</span>
        </div>

        <div class="transcript-box" id="transcript-box">
          <span style="color: #475569; font-style: italic; font-size: 12px;">Bật dịch để bắt đầu...</span>
        </div>
      </div>
    </div>
  `;

  shadow.innerHTML = html;

  // ── DOM References ─────────────────────────────────────────────────────────
  const dragHandle = shadow.getElementById('drag-handle');
  const settingsBtn = shadow.getElementById('settings-btn');
  const closeBtn = shadow.getElementById('close-btn');
  const minimizeBtn = shadow.getElementById('minimize-btn');
  const settingsPanel = shadow.getElementById('settings-panel');
  const apiKeyInput = shadow.getElementById('api-key');
  const sourceLangSelect = shadow.getElementById('source-lang');
  const toggleBtn = shadow.getElementById('toggle-btn');
  const statusDot = shadow.getElementById('status-dot');
  const statusText = shadow.getElementById('status-text');
  const transcriptBox = shadow.getElementById('transcript-box');
  const speedSlider = shadow.getElementById('tts-speed');
  const speedVal = shadow.getElementById('speed-val');
  const ttsEngineSelect = shadow.getElementById('tts-engine');
  const ttsVoiceSelect = shadow.getElementById('tts-voice');
  const testTtsBtn = shadow.getElementById('test-tts-btn');

  let subtitleFetcher = null;
  let subtitleSync = null;

  function initSubtitleFetcher() {
    if (subtitleFetcher) return true;
    if (window.SubtitleFetcher) {
      subtitleFetcher = new window.SubtitleFetcher();
      console.log('[VidTrans] ✅ SubtitleFetcher initialized');
      return true;
    }
    console.error('[VidTrans] ❌ SubtitleFetcher class not found in window object');
    return false;
  }

  // Initial attempt
  initSubtitleFetcher();

  // ── State ─────────────────────────────────────────────────────────────────
  let isRunning = false;
  let mode = 'live'; // 'live' or 'subtitles'
  let syncTimer = null;

  // ── TTS Bridge (unified interface for all engines) ─────────────────────────
  //
  // Edge TTS → routes to offscreen (WebSocket streaming)
  // Native TTS → plays locally in content.js (lower latency)
  //
  // Both engines emit word boundary events for subtitle pagination:
  //   Edge TTS  → TTS_WORD_BOUNDARY message from offscreen
  //   Native TTS → SpeechSynthesisUtterance.onboundary (local)
  //
  // This is the ONLY place in content.js that handles TTS playback.
  class TTSBridge {
    constructor() {
      this._enabled = true;
      this._lastSpoken = '';
    }

    /**
     * Speak text using the currently selected engine.
     * @param {string} text
     */
    speak(text) {
      if (!this._enabled || !text?.trim()) return;
      if (text === this._lastSpoken) return;
      this._lastSpoken = text;

      if (ttsEngine === 'edge') {
        // Edge TTS plays in offscreen via WebSocket.
        // Ducking is triggered by TTS_STATE_CHANGED message from offscreen.
        chrome.runtime.sendMessage({
          type: 'SPEAK_SUBTITLE',
          text, ttsEngine, ttsRate, ttsVoice
        }).catch(err => console.error('[TTSBridge] Send failed:', err));
      } else {
        this._playNative(text);
      }
    }

    /**
     * Play text using browser SpeechSynthesis (native engine).
     * Emits word boundary events locally for subtitle pagination.
     * @param {string} text
     */
    _playNative(text) {
      speechSynthesis.cancel();
      setTimeout(() => {
        const utt = new SpeechSynthesisUtterance(text);
        const voices = speechSynthesis.getVoices();
        const voiceObj = voices.find(v => v.voiceURI === ttsVoice || v.name === ttsVoice);

        if (voiceObj) utt.voice = voiceObj;
        else utt.lang = 'vi-VN';

        utt.rate = ttsRate;
        utt.onstart = () => duckVideoVolume();
        utt.onend = () => restoreVideoVolume();
        utt.onerror = () => restoreVideoVolume();

        // Word boundary → drive subtitle pagination (same as Edge TTS)
        utt.onboundary = (event) => {
          if (event.name === 'word') {
            handleWordBoundary({
              textOffset: event.charIndex,
              textLength: event.charLength || 0,
              word: text.substring(event.charIndex, event.charIndex + (event.charLength || 1)),
              fullText: text,
            });
          }
        };

        speechSynthesis.speak(utt);
      }, 50);
    }

    /**
     * Stop all playback and disable further speech.
     */
    stop() {
      this._enabled = false;
      speechSynthesis.cancel();
      restoreVideoVolume();
      this._lastSpoken = '';
    }
  }

  let ttsBridge = null;

  // ── Subtitle Overlay + Paginator ──────────────────────────────────────────
  let subtitleOverlay = null;

  /** @type {SubtitlePaginator|null} */
  let subtitlePaginator = null;

  function ensurePaginator() {
    // Dynamically calculate chars per line based on actual overlay width or screen width
    // Average char width at 24px font size is roughly 12px. Padding is 56px (28px * 2).
    const overlayWidth = subtitleOverlay ? subtitleOverlay.clientWidth : (window.innerWidth / 3);
    // Ensure we have at least 30 chars per line even on very small screens
    const estimatedCharsPerLine = Math.max(30, Math.floor((overlayWidth - 56) / 12));

    if (!subtitlePaginator && window.SubtitlePaginator) {
      subtitlePaginator = new window.SubtitlePaginator({
        maxLines: 2,
        charsPerLine: estimatedCharsPerLine,
      });
    } else if (subtitlePaginator) {
      // Update dynamically if overlay was resized significantly
      if (Math.abs(subtitlePaginator.charsPerLine - estimatedCharsPerLine) > 5) {
        subtitlePaginator.charsPerLine = estimatedCharsPerLine;
      }
    }
    return subtitlePaginator;
  }

  function createSubtitleOverlay() {
    if (subtitleOverlay) return subtitleOverlay;

    subtitleOverlay = document.createElement('div');
    subtitleOverlay.id = 'vidtrans-subtitle-overlay';

    // Apply saved position
    subtitleOverlay.style.left = subtitlePos.left;
    if (subtitlePos.left === '50%') {
      subtitleOverlay.style.transform = 'translateX(-50%)';
    } else {
      subtitleOverlay.style.transform = 'none';
    }

    if (subtitlePos.top && subtitlePos.top !== 'auto') {
      subtitleOverlay.style.top = subtitlePos.top;
      subtitleOverlay.style.bottom = 'auto';
    } else {
      subtitleOverlay.style.bottom = subtitlePos.bottom;
    }

    // Drag and drop for subtitle overlay
    let isDraggingSub = false;
    let startX, startY, startLeft, startBottom, startTop;

    subtitleOverlay.addEventListener('mousedown', (e) => {
      isDraggingSub = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = subtitleOverlay.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      subtitleOverlay.style.transition = 'none'; // Disable transition during drag
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDraggingSub) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const newLeft = startLeft + dx;
      const newTop = startTop + dy;

      subtitleOverlay.style.left = `${newLeft}px`;
      subtitleOverlay.style.top = `${newTop}px`;
      subtitleOverlay.style.bottom = 'auto';
      subtitleOverlay.style.transform = 'none';
    });

    window.addEventListener('mouseup', () => {
      if (isDraggingSub) {
        isDraggingSub = false;
        subtitleOverlay.style.transition = 'opacity 0.3s ease';

        // Save position
        subtitlePos = {
          left: subtitleOverlay.style.left,
          top: subtitleOverlay.style.top,
          bottom: 'auto'
        };
        chrome.storage.local.set({ [SUBTITLE_POS_STORAGE]: subtitlePos });
      }
    });

    document.body.appendChild(subtitleOverlay);
    return subtitleOverlay;
  }

  /** @internal — called by stopTranslation */
  function removeSubtitleOverlay() {
    if (subtitleOverlay) {
      subtitleOverlay.remove();
      subtitleOverlay = null;
    }
    if (subtitlePaginator) {
      subtitlePaginator.clear();
    }
  }

  /**
   * Update the subtitle overlay with paginated text.
   * Shows only the current 2-line page. Pages advance via word boundary events.
   *
   * @param {string} originalText  - Original (untranslated) text
   * @param {string} translatedText - Translated text to display
   */
  function updateSubtitle(originalText, translatedText) {
    if (!subtitleOverlay) {
      createSubtitleOverlay();
    }

    const paginator = ensurePaginator();
    if (paginator) {
      const result = paginator.setText(translatedText, originalText);
      const indicator = result.totalPages > 1 ? `${result.pageIndex + 1}/${result.totalPages}` : '';
      renderSubtitlePage(result.page, originalText, indicator);
    } else {
      // Fallback: show the whole text at once
      subtitleOverlay.innerHTML = `
        <span class="vidtrans-subtitle-text">${escapeHtml(translatedText)}</span>
        ${originalText ? `<span class="vidtrans-subtitle-original">${escapeHtml(originalText)}</span>` : ''}
      `;
    }

    subtitleOverlay.classList.remove('vidtrans-hidden');
  }

  /**
   * Render a single page of subtitle text into the overlay.
   * @param {string} pageText     - Current page content (may contain \n for line breaks)
   * @param {string} originalText - Original text
   * @param {string} indicator    - Page indicator (e.g. "1/3") or empty
   */
  function renderSubtitlePage(pageText, originalText, indicator) {
    if (!subtitleOverlay) return;

    let html = `<span class="vidtrans-subtitle-text">${escapeHtml(pageText)}</span>`;

    if (originalText) {
      html += `<span class="vidtrans-subtitle-original">${escapeHtml(originalText)}</span>`;
    }

    if (indicator) {
      // html += `<span class="vidtrans-subtitle-page-indicator">${escapeHtml(indicator)}</span>`;
    }

    subtitleOverlay.innerHTML = html;
  }

  /**
   * Handle word boundary events from both Edge TTS (via message) and Native TTS (via onboundary).
   * Advances the paginator page when the reading position crosses a page boundary.
   *
   * @param {{ textOffset: number, fullText: string, word?: string, textLength?: number }} data
   */
  function handleWordBoundary(data) {
    const paginator = ensurePaginator();
    if (!paginator || !paginator.needsPagination) return;

    const result = paginator.onWordBoundary(data.textOffset);
    if (result.changed) {
      const indicator = result.totalPages > 1 ? `${result.pageIndex + 1}/${result.totalPages}` : '';
      renderSubtitlePage(result.page, paginator.originalText, indicator);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ── Status Updates ──────────────────────────────────────────────────────────
  function setStatus(text, type = 'idle') {
    statusText.textContent = text;
    statusDot.className = 'status-dot';
    if (type === 'active') statusDot.classList.add('active');
    else if (type === 'error') statusDot.classList.add('error');
    else if (type === 'warning') statusDot.classList.add('warning');
  }

  // ── Transcript Display ──────────────────────────────────────────────────────
  function addTranscript(original, translated) {
    // Clear placeholder
    if (transcriptBox.querySelector('span[style*="italic"]')) {
      transcriptBox.innerHTML = '';
    }

    const item = document.createElement('div');
    item.className = 'transcript-item';
    item.innerHTML = `
      <span class="transcript-vi">${escapeHtml(translated)}</span>
      <span class="transcript-en">${escapeHtml(original)}</span>
    `;

    transcriptBox.appendChild(item);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
  }

  function addStatusMessage(message, isError = false) {
    const item = document.createElement('div');
    item.className = 'transcript-item';
    item.style.color = isError ? '#ef4444' : '#10b981';
    item.style.fontSize = '12px';
    item.textContent = message;

    transcriptBox.appendChild(item);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
  }

  // ── Event Handlers ─────────────────────────────────────────────────────────

  // Drag & Drop
  let isDragging = false;
  let dragStartX, dragStartY, dragStartRight, dragStartTop;

  dragHandle.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartRight = parseInt(container.style.right) || 0;
    dragStartTop = parseInt(container.style.top) || 0;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = dragStartX - e.clientX;
    const dy = e.clientY - dragStartY;
    container.style.right = `${dragStartRight + dx}px`;
    container.style.top = `${dragStartTop + dy}px`;
    container.style.left = 'auto';
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;

    // Save position
    chrome.storage.local.set({
      [PANEL_POS_STORAGE]: {
        right: container.style.right,
        top: container.style.top
      }
    });
  });

  // Settings toggle
  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('active');
  });

  // Minimize
  minimizeBtn.addEventListener('click', () => {
    container.style.display = 'none';
  });

  // Close → cleanup
  closeBtn.addEventListener('click', () => {
    container.style.display = 'none';
    stopTranslation();
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  });

  // API Key save — now using local storage for persistence
  apiKeyInput.addEventListener('input', async (e) => {
    const val = e.target.value.trim();
    await chrome.storage.local.set({ [API_KEY_STORAGE]: val });
    apiKey = val;

    if (val) {
      toggleBtn.disabled = false;
      toggleBtn.textContent = '▶ BẬT DỊCH';
      setStatus('Sẵn sàng');
    } else {
      toggleBtn.disabled = true;
      toggleBtn.textContent = '🔒 Cần API Key';
      setStatus('Chưa có API Key', 'warning');
    }
  });

  // Dynamic Voice List Management
  async function updateVoiceList() {
    if (!ttsVoiceSelect) return;

    if (ttsEngine === 'native') {
      ttsVoiceSelect.innerHTML = '<option disabled>Đang nạp giọng Trình duyệt...</option>';
      const voices = speechSynthesis.getVoices();
      const langPrefix = targetLang.split('-')[0].toLowerCase();

      const filtered = voices.filter(v => {
        const lang = (v.lang || '').toLowerCase();
        const name = (v.name || '').toLowerCase();
        return lang.startsWith(langPrefix) || name.includes('multilingual');
      });

      ttsVoiceSelect.innerHTML = '';
      if (filtered.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = `Không tìm thấy giọng ${langPrefix.toUpperCase()}`;
        opt.disabled = true;
        ttsVoiceSelect.appendChild(opt);
        return;
      }

      // Sắp xếp: Ưu tiên giọng bản địa lên đầu
      filtered.sort((a, b) => {
        const aIsNative = (a.lang || '').toLowerCase().startsWith(langPrefix);
        const bIsNative = (b.lang || '').toLowerCase().startsWith(langPrefix);
        if (aIsNative && !bIsNative) return -1;
        if (!aIsNative && bIsNative) return 1;
        return 0;
      });

      filtered.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.voiceURI;
        const isMultilingual = !(v.lang || '').toLowerCase().startsWith(langPrefix);
        const prefix = isMultilingual ? '🌐 ' : '';
        opt.textContent = `${prefix}${v.name}`;
        if (v.voiceURI === ttsVoice) opt.selected = true;
        ttsVoiceSelect.appendChild(opt);
      });
    } else {
      ttsVoiceSelect.innerHTML = '<option disabled>Đang nạp giọng Microsoft...</option>';
      try {
        const response = await new Promise(resolve => {
          chrome.runtime.sendMessage({ type: 'GET_EDGE_VOICES' }, resolve);
        });
        const voices = response?.voices || [];
        const langPrefix = targetLang.split('-')[0].toLowerCase();

        // Lọc giọng: Lấy giọng đúng ngôn ngữ HOẶC giọng Multilingual
        const filtered = voices.filter(v => {
          const locale = (v.Locale || '').toLowerCase();
          const name = (v.FriendlyName || v.ShortName || '').toLowerCase();
          return locale.startsWith(langPrefix) || name.includes('multilingual');
        });

        ttsVoiceSelect.innerHTML = '';
        if (filtered.length === 0) {
          const opt = document.createElement('option');
          opt.textContent = `Không tìm thấy giọng ${langPrefix.toUpperCase()}`;
          opt.disabled = true;
          ttsVoiceSelect.appendChild(opt);
          return;
        }

        // Sắp xếp: Ưu tiên giọng bản địa lên đầu, giọng Multilingual xuống dưới
        filtered.sort((a, b) => {
          const aIsNative = a.Locale.toLowerCase().startsWith(langPrefix);
          const bIsNative = b.Locale.toLowerCase().startsWith(langPrefix);
          if (aIsNative && !bIsNative) return -1;
          if (!aIsNative && bIsNative) return 1;
          return 0;
        });

        filtered.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.ShortName;
          const isMultilingual = !(v.Locale || '').toLowerCase().startsWith(langPrefix);
          const prefix = isMultilingual ? '🌐 ' : '';
          opt.textContent = `${prefix}${v.FriendlyName || v.ShortName} (${v.Gender})`;
          if (v.ShortName === ttsVoice) opt.selected = true;
          ttsVoiceSelect.appendChild(opt);
        });
      } catch (err) {
        ttsVoiceSelect.innerHTML = '<option disabled>Lỗi tải danh sách giọng</option>';
      }
    }

    // Auto-select first voice if invalid
    const currentOpt = Array.from(ttsVoiceSelect.options).find(opt => opt.value === ttsVoice);
    if (!currentOpt && ttsVoiceSelect.options.length > 0 && !ttsVoiceSelect.options[0].disabled) {
      ttsVoice = ttsVoiceSelect.options[0].value;
      chrome.storage.local.set({ [TTS_VOICE_STORAGE]: ttsVoice });
      ttsVoiceSelect.selectedIndex = 0;

      // TTSBridge reads global ttsVoice, no extra action needed
      // (No action needed as speak() uses global ttsVoice variable)
    }
  }

  // Load voices dynamically on init
  speechSynthesis.onvoiceschanged = () => {
    if (ttsEngine === 'native') updateVoiceList();
  };

  // Trigger fetch
  speechSynthesis.getVoices();
  updateVoiceList();


  // Source language save
  sourceLangSelect.addEventListener('change', async (e) => {
    targetLang = e.target.value;
    await chrome.storage.local.set({ [SOURCE_LANG_STORAGE]: targetLang });
    updateVoiceList(); // Refresh voices for new language
  });

  // Speed rate save
  speedSlider.addEventListener('input', async (e) => {
    ttsRate = parseFloat(e.target.value);
    speedVal.textContent = ttsRate.toFixed(1);
    await chrome.storage.local.set({ [TTS_RATE_STORAGE]: ttsRate });
  });

  // Engine save
  ttsEngineSelect.addEventListener('change', async (e) => {
    ttsEngine = e.target.value;
    await chrome.storage.local.set({ [TTS_ENGINE_STORAGE]: ttsEngine });
    updateVoiceList(); // Refresh voice list for new engine
  });

  // Voice save
  ttsVoiceSelect.addEventListener('change', async (e) => {
    ttsVoice = e.target.value;
    await chrome.storage.local.set({ [TTS_VOICE_STORAGE]: ttsVoice });
  });

  // Test TTS
  testTtsBtn.addEventListener('click', () => {
    try {
      const testText = 'Chào bạn, đây là giọng đọc thử nghiệm của hệ thống VidTrans.';
      if (ttsEngine === 'native') {
        let tempTts = ttsBridge || new TTSBridge();
        tempTts.speak(testText);
      } else {
        chrome.runtime.sendMessage({
          type: 'TEST_TTS',
          text: testText,
          ttsEngine: ttsEngine,
          ttsRate: ttsRate,
          ttsVoice: ttsVoice
        });
      }
    } catch (err) {
      if (err.message.includes('context invalidated')) {
        alert('Extension đã được cập nhật. Vui lòng F5 lại trang YouTube để tiếp tục!');
      } else {
        console.error('[VidTrans] Test TTS error:', err);
      }
    }
  });

  // Toggle translation
  toggleBtn.addEventListener('click', () => {
    console.log('[VidTrans] 🖱️ Toggle button clicked, current state isRunning:', isRunning);
    if (!isRunning) {
      startTranslation().catch(err => {
        console.error('[VidTrans] ❌ Failed to start translation:', err);
        setStatus('Lỗi khởi động: ' + err.message, 'error');
      });
    } else {
      stopTranslation();
    }
  });

  // ── Translation Control ────────────────────────────────────────────────────

  async function startTranslationMode() {
    const video = document.querySelector('video');
    if (!video) {
      setStatus('Không tìm thấy video', 'error');
      isRunning = false;
      updateToggleButton();
      return;
    }

    try {
      // Try to get subtitles first
      setStatus('Đang quét phụ đề...', 'warning');
      console.log('[VidTrans] 🔍 Scanning for subtitles at:', window.location.href);

      // Small delay to ensure YouTube scripts/DOM are ready
      await new Promise(r => setTimeout(r, 800));

      // Ensure subtitle fetcher is initialized (retry if it was missing during boot)
      if (!subtitleFetcher) {
        console.log('[VidTrans] 🔄 Attempting to re-initialize SubtitleFetcher...');
        initSubtitleFetcher();
      }

      let subs = null;
      if (subtitleFetcher) {
        console.log('[VidTrans] 📥 Calling fetchSubtitles with target language:', targetLang);
        subs = await subtitleFetcher.fetchSubtitles(window.location.href, targetLang);
      } else {
        console.warn('[VidTrans] ⚠️ SubtitleFetcher still missing, skipping subtitle scan.');
      }

      if (subs && subs.events && subs.events.length > 0) {
        console.log(`[VidTrans] 📝 Found ${subs.events.length} subtitles (${subs.lang}), needsTranslation=${subs.needsTranslation}`);
        mode = 'subtitles';

        await startSyncTimer(video, subs);

      } else {
        console.log('[VidTrans] 🎙️ No subtitles found or timed out, using LIVE MODE');
        mode = 'live';
        ttsBridge = new TTSBridge();
        chrome.runtime.sendMessage({
          type: 'START_TRANSLATION',
          apiKey: apiKey,
          targetLang: targetLang,
          ttsEngine: ttsEngine,
          ttsRate: ttsRate,
          ttsVoice: ttsVoice
        });
        setStatus('Đang dịch trực tiếp', 'active');
      }
    } catch (err) {
      console.error('[VidTrans] ❌ Error during translation mode startup:', err);
      setStatus('Lỗi khởi tạo. Chuyển sang Dịch trực tiếp...', 'warning');

      // Fallback to Live Mode
      mode = 'live';
      ttsBridge = new TTSBridge();
      chrome.runtime.sendMessage({
        type: 'START_TRANSLATION',
        apiKey: apiKey,
        targetLang: targetLang,
        ttsEngine: ttsEngine,
        ttsRate: ttsRate,
        ttsVoice: ttsVoice
      });
      setStatus('Đang dịch trực tiếp', 'active');
    }
  }

  // ── Groq Batch Translate ───────────────────────────────────────────────────
  // LANG_NAMES loaded from lib/constants.js (window.LANG_NAMES)
  const CHUNK_SIZE = 50; // Lines per API call — stays well within token limits

  async function translateChunk(texts, langName) {
    const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const prompt = `Translate the following subtitle lines to ${langName}.
Output ONLY the translations with same numbering (1. 2. 3. ...). No extra text.

${numbered}`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: texts.length * 80,
        temperature: 0.1,
      })
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const raw = data.choices?.[0]?.message?.content?.trim() || '';
    if (!raw) throw new Error('Empty Groq response');

    // Parse "N. text" → map index → translation
    const result = new Array(texts.length);
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\d+)\.\s*(.+)/);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        if (idx >= 0 && idx < texts.length) result[idx] = m[2].trim();
      }
    }
    return result;
  }

  async function groqTranslateBatch(events, langCode) {
    if (!apiKey) return events;
    const langName = LANG_NAMES[langCode] || langCode;
    console.log(`[VidTrans] 🌐 Batch translating ${events.length} events → ${langName}`);

    // Deduplicate for API efficiency
    const unique = [...new Set(events.map(e => e.text).filter(t => t.trim()))];
    const translationMap = new Map();

    // Chunk into CHUNK_SIZE batches
    const chunks = [];
    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      chunks.push(unique.slice(i, i + CHUNK_SIZE));
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      setStatus(`Đang dịch... (${ci * CHUNK_SIZE + chunk.length}/${unique.length})`, 'warning');
      try {
        const translated = await translateChunk(chunk, langName);
        chunk.forEach((original, i) => {
          if (translated[i]) translationMap.set(original, translated[i]);
        });
        console.log(`[VidTrans] ✅ Chunk ${ci + 1}/${chunks.length}: ${translationMap.size} translated`);
      } catch (err) {
        console.error(`[VidTrans] ❌ Chunk ${ci + 1} failed:`, err.message);
        // Keep untranslated for this chunk — show original as fallback
      }
    }

    console.log(`[VidTrans] 🎉 Total: ${translationMap.size}/${unique.length} lines translated`);

    return events.map(e => ({
      ...e,
      translated: translationMap.get(e.text) || null, // null = show original
    }));
  }

  async function startSyncTimer(video, subs) {
    if (subtitleSync) subtitleSync.stop();

    if (!window.SubtitleSync) {
      console.error('[VidTrans] SubtitleSync not loaded');
      return;
    }

    let events = subs.events;

    if (subs.needsTranslation) {
      setStatus('Đang dịch toàn bộ phụ đề...', 'warning');
      events = await groqTranslateBatch(subs.events, targetLang);
      console.log('[VidTrans] ✅ Batch translation complete');
    }

    subtitleSync = new window.SubtitleSync();
    subtitleSync.load(events);

    // DEBUG: Auto-log the first 20 events to help diagnose latency
    console.log("%c--- DỮ LIỆU PHỤ ĐỀ (DEBUG) ---", "color: #2563eb; font-weight: bold; font-size: 14px;");
    const debugData = events.slice(0, 20).map((e, i) => ({
      "STT": i + 1,
      "Mốc (s)": (e.start / 1000).toFixed(2),
      "Dài (s)": (e.duration / 1000).toFixed(2),
      "Gốc (Anh)": e.text,
      "Dịch (Việt)": e.translated || "(N/A)",
      "Tỷ lệ dài": ((e.translated || "").length / (e.text || 1).length).toFixed(1) + 'x'
    }));
    console.table(debugData);

    ttsBridge = new TTSBridge();

    // ── Pre-render configuration (Edge TTS only) ──────────────────────────
    const usePrerender = ttsEngine === 'edge';
    const LOOKAHEAD = 5;

    if (usePrerender) {
      // Pre-render the first batch immediately so the first few subtitles
      // have zero latency when playback starts
      const initialTexts = events.slice(0, LOOKAHEAD).map(e => e.translated || e.text).filter(t => t?.trim());
      if (initialTexts.length > 0) {
        console.log(`[VidTrans] 📦 Pre-rendering first ${initialTexts.length} subtitles...`);
        setStatus(`Pre-rendering ${initialTexts.length} câu đầu...`, 'warning');
        try {
          chrome.runtime.sendMessage({
            type: 'PRERENDER_SUBTITLES',
            texts: initialTexts,
            ttsEngine, ttsRate, ttsVoice
          });
        } catch (err) {
          console.error('[VidTrans] Initial pre-render send failed:', err);
        }
      }
    }

    const prerenderOptions = usePrerender ? {
      lookahead: LOOKAHEAD,

      // Called when SubtitleSync detects upcoming events to pre-render
      onPrerender: (texts) => {
        console.log(`[VidTrans] 📦 Lookahead: pre-rendering ${texts.length} upcoming subtitles`);
        try {
          chrome.runtime.sendMessage({
            type: 'PRERENDER_SUBTITLES',
            texts,
            ttsEngine, ttsRate, ttsVoice
          });
        } catch (err) {
          console.error('[VidTrans] Pre-render send failed:', err);
        }
      },

      // Called to play the current subtitle — uses pre-rendered cache
      onPlayPrerendered: (text) => {
        try {
          chrome.runtime.sendMessage({
            type: 'PLAY_PRERENDERED',
            text,
            ttsEngine, ttsRate, ttsVoice
          }).catch(err => console.error('[VidTrans] Play prerendered failed:', err));
        } catch (err) {
          // Fallback to normal speak
          ttsBridge.speak(text);
        }
      }
    } : {};

    subtitleSync.start(
      video,
      (displayText, originalText) => {
        updateSubtitle(originalText, displayText);
        addTranscript(originalText || displayText, displayText);

        // For native TTS (no pre-render), speak directly
        if (!usePrerender) {
          ttsBridge.speak(displayText);
        }
        // For Edge TTS with pre-render, playback is handled by onPlayPrerendered
      },
      () => {
        if (subtitleOverlay) subtitleOverlay.classList.add('vidtrans-hidden');
      },
      prerenderOptions
    );

    const label = subs.needsTranslation
      ? `Phụ đề (${subs.lang.toUpperCase()}) → đã dịch`
      : `Phụ đề native (${subs.lang.toUpperCase()})`;
    const prerenderLabel = usePrerender ? ' (pre-render ⚡)' : '';
    setStatus(label + prerenderLabel, 'active');
    console.log('[VidTrans] ▶ SubtitleSync started —', label + prerenderLabel);
  }


  function updateToggleButton() {
    if (isRunning) {
      toggleBtn.textContent = '⏸ TẮT DỊCH';
      toggleBtn.classList.add('active');
    } else {
      toggleBtn.textContent = '▶ BẬT DỊCH';
      toggleBtn.classList.remove('active');
    }
  }

  async function startTranslation() {
    console.log('[VidTrans] 🚀 Starting translation process...');
    if (!apiKey) {
      alert('Vui lòng nhập Groq API Key!');
      settingsBtn.click();
      return;
    }

    isRunning = true;
    updateToggleButton();
    transcriptBox.innerHTML = '';

    createSubtitleOverlay();
    await startTranslationMode();
  }

  function stopTranslation() {
    console.log('[VidTrans] 🛑 Stopping translation...');
    isRunning = false;
    updateToggleButton();
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    if (subtitleSync) { subtitleSync.stop(); subtitleSync = null; }
    if (ttsBridge) { ttsBridge.stop(); ttsBridge = null; }
    if (subtitlePaginator) { subtitlePaginator.clear(); }

    chrome.runtime.sendMessage({ type: 'STOP_TRANSLATION' });
    setStatus('Sẵn sàng');

    if (subtitleOverlay) {
      subtitleOverlay.remove();
      subtitleOverlay = null;
    }
  }

  // ── Message Listener ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOGGLE_PANEL') {
      console.log('[VidTrans] 📥 Received TOGGLE_PANEL message:', msg);
      if (!container) {
        console.error('[VidTrans] ❌ Cannot toggle panel: container is null');
        return;
      }

      if (msg.show === true) {
        container.style.display = 'block';
      } else if (msg.show === false) {
        container.style.display = 'none';
      } else {
        // More robust check for hidden state
        const isHidden = !container.style.display || container.style.display === 'none';
        container.style.display = isHidden ? 'block' : 'none';
      }
      console.log('[VidTrans] 👁️ Panel display is now:', container.style.display);

    } else if (msg.type === 'UPDATE_TRANSCRIPT') {
      const { original, translated } = msg;

      // Normalize text for perfect sync (matching Edge TTS normalization)
      const normalizedTranslated = translated.replace(/\.\.+/g, '.').replace(/\. /g, ', ').trim();

      // Update UI
      addTranscript(original, normalizedTranslated);
      updateSubtitle(original, normalizedTranslated);

      if (ttsEngine === 'native' && ttsBridge && normalizedTranslated) {
        ttsBridge.speak(normalizedTranslated);
      }

      // Update status
      if (isRunning) {
        setStatus('Đang phiên dịch...', 'active');
      }
    } else if (msg.type === 'TTS_STATE_CHANGED') {
      if (msg.playing) {
        duckVideoVolume();
      } else {
        restoreVideoVolume();
      }
    } else if (msg.type === 'TTS_WORD_BOUNDARY') {
      handleWordBoundary(msg);
    } else if (msg.type === 'UPDATE_TRANSCRIPT_ERROR') {
      addStatusMessage(msg.message, msg.isError);

      if (msg.isError) {
        setStatus(msg.message, 'error');
      } else {
        setStatus(msg.message, 'warning');
      }

    } else if (msg.type === 'UPDATE_TRANSCRIPT_STATUS') {
      setStatus(msg.message, 'active');

    } else if (msg.type === 'PRERENDER_COMPLETE') {
      console.log(`[VidTrans] ✅ Pre-render complete: ${msg.count}/${msg.total} (cache: ${msg.stats?.size || 0})`);
      if (isRunning && mode === 'subtitles') {
        setStatus(`Phụ đề (pre-render: ${msg.stats?.size || 0} cached) ⚡`, 'active');
      }

    } else if (msg.type === 'CHECK_UI') {
      // Background checking if UI exists — respond ok
      chrome.runtime.sendMessage({ type: 'UI_OK' });
    }
  });

  // ── YouTube SPA Re-inject ─────────────────────────────────────────────────
  if (window.location.hostname.includes('youtube.com')) {
    // yt-navigate-finish fires when YouTube SPA navigation completes
    document.addEventListener('yt-navigate-finish', () => {
      console.log('[VidTrans] 🔄 YouTube navigation detected');

      // If we are running, we need to restart for the new video
      if (isRunning) {
        console.log('[VidTrans] 🔄 Restarting translation for new video...');
        stopTranslation();
        setTimeout(() => {
          startTranslation();
        }, 1000); // Give it a moment to settle
      }
    });

    // MutationObserver: detect if <video> appears/disappears (useful for Shorts/Reels)
    const videoObserver = new MutationObserver((mutations) => {
      // If a new video appears and we are not running but maybe we should be?
      // Or if the video was replaced.
    });
    videoObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Init Status ────────────────────────────────────────────────────────────
  if (apiKey) {
    setStatus('Sẵn sàng');
  } else {
    setStatus('Chưa có API Key', 'warning');
  }

  // Debug helper: Export raw data to file
  window.__vidtrans_export_raw = function () {
    const data = window.__vidtrans_raw_data;
    if (!data) return console.error("Không có dữ liệu để xuất!");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'raw_subtitles.json';
    a.click();
    console.log("Đã xuất file raw_subtitles.json");
  };
})();
