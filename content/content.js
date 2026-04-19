// content/content.js
// Floating UI Panel + Subtitle Overlay + Audio Ducking + TTS
(async function () {
  'use strict';

  if (window.__vidtrans_ui_injected__) {
    const root = document.getElementById('vidtrans-root');
    if (root) {
      root.style.display = root.style.display === 'none' ? 'block' : 'none';
    }
    return;
  }
  window.__vidtrans_ui_injected__ = true;

  // ── Storage Keys ───────────────────────────────────────────────────────────
  const API_KEY_STORAGE = 'vidtrans_groq_key';
  const SOURCE_LANG_STORAGE = 'vidtrans_source_lang';
  const PANEL_POS_STORAGE = 'vidtrans_panel_pos';

  // ── Load State ─────────────────────────────────────────────────────────────
  const state = await chrome.storage.local.get([API_KEY_STORAGE, SOURCE_LANG_STORAGE, PANEL_POS_STORAGE]);
  let apiKey = state[API_KEY_STORAGE] || '';
  let sourceLang = state[SOURCE_LANG_STORAGE] || 'en-US';
  let panelPos = state[PANEL_POS_STORAGE] || { right: '20px', top: '20px' };

  // ── TTS Queue (lazy init) ─────────────────────────────────────────────────
  let ttsQueue = null;

  /** @returns {{ speak: Function, cancel: Function, queueLength: number }} */
  function getTTSQueue() {
    if (!ttsQueue) {
      // Dynamic import to avoid loading if not needed
      ttsQueue = createTTSQueue();
    }
    return ttsQueue;
  }

  /**
   * @returns {import('../lib/tts-queue.js').TTSQueue}
   */
  function createTTSQueue() {
    // Inline TTSQueue — content script can't use ES modules
    class InlineTTSQueue {
      constructor() {
        this._queue = [];
        this._isPlaying = false;
      }

      speak(text) {
        if (!text?.trim()) return;
        const trimmed = text.trim();
        if (this._queue.includes(trimmed)) return;
        this._queue.push(trimmed);
        if (!this._isPlaying) this._playNext();
      }

      cancel() {
        speechSynthesis.cancel();
        this._queue = [];
        this._isPlaying = false;
      }

      get queueLength() { return this._queue.length; }

      _playNext() {
        if (this._queue.length === 0) {
          this._isPlaying = false;
          restoreVideoVolume();
          return;
        }
        this._isPlaying = true;
        const text = this._queue.shift();
        const utt = new SpeechSynthesisUtterance(text);
        utt.lang = 'vi-VN';
        utt.rate = 1.1;
        utt.onend = () => this._playNext();
        utt.onerror = () => this._playNext();
        duckVideoVolume();
        speechSynthesis.speak(utt);
      }
    }
    return new InlineTTSQueue();
  }

  // ── Audio Ducking ──────────────────────────────────────────────────────────
  /** @type {Map<HTMLVideoElement, number>} */
  const videoVolumeMap = new Map();

  function duckVideoVolume() {
    document.querySelectorAll('video').forEach(v => {
      if (!videoVolumeMap.has(v)) {
        videoVolumeMap.set(v, v.volume);
      }
      v.volume = Math.max(v.volume * 0.2, 0.05);
    });
  }

  function restoreVideoVolume() {
    videoVolumeMap.forEach((origVol, v) => {
      if (!v.paused && !v.ended) {
        v.volume = origVol;
      }
    });
    // Clear after short delay to avoid restoring mid-sentence
    setTimeout(() => videoVolumeMap.clear(), 2000);
  }

  // ── Create Container ────────────────────────────────────────────────────────
  const container = document.createElement('div');
  container.id = 'vidtrans-root';
  Object.assign(container.style, {
    position: 'fixed',
    right: panelPos.right,
    top: panelPos.top,
    zIndex: '2147483647',
  });
  document.body.appendChild(container);

  // Shadow DOM for CSS isolation
  const shadow = container.attachShadow({ mode: 'open' });

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
        margin-top: 4px;
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
      </div>

      <div class="content">
        <div class="form-group">
          <label>Ngôn ngữ video</label>
          <select id="source-lang">
            <option value="en-US" ${sourceLang==='en-US'?'selected':''}>English (Mỹ)</option>
            <option value="en-GB" ${sourceLang==='en-GB'?'selected':''}>English (Anh)</option>
            <option value="ja-JP" ${sourceLang==='ja-JP'?'selected':''}>日本語 (Nhật)</option>
            <option value="ko-KR" ${sourceLang==='ko-KR'?'selected':''}>한국어 (Hàn)</option>
            <option value="zh-CN" ${sourceLang==='zh-CN'?'selected':''}>中文 (Trung)</option>
            <option value="fr-FR" ${sourceLang==='fr-FR'?'selected':''}>Français (Pháp)</option>
            <option value="de-DE" ${sourceLang==='de-DE'?'selected':''}>Deutsch (Đức)</option>
            <option value="es-ES" ${sourceLang==='es-ES'?'selected':''}>Español (Tây)</option>
          </select>
        </div>

        <button class="toggle-btn" id="toggle-btn" ${!apiKey ? 'disabled' : ''}>
          ${!apiKey ? '🔒 Cần API Key' : '▶ BẬT DỊCH'}
        </button>

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

  // ── State ─────────────────────────────────────────────────────────────────
  let isRunning = false;

  // ── Subtitle Overlay ───────────────────────────────────────────────────────
  let subtitleOverlay = null;

  function createSubtitleOverlay() {
    if (subtitleOverlay) return subtitleOverlay;

    subtitleOverlay = document.createElement('div');
    subtitleOverlay.id = 'vidtrans-subtitle-overlay';

    // Style will come from content.css
    document.body.appendChild(subtitleOverlay);
    return subtitleOverlay;
  }

  /** @internal — called by stopTranslation */
  function removeSubtitleOverlay() {
    if (subtitleOverlay) {
      subtitleOverlay.remove();
      subtitleOverlay = null;
    }
  }

  function updateSubtitle(originalText, translatedText) {
    if (!subtitleOverlay) {
      createSubtitleOverlay();
    }

    subtitleOverlay.innerHTML = `
      <span class="vidtrans-subtitle-text">${escapeHtml(translatedText)}</span>
      ${originalText ? `<span class="vidtrans-subtitle-original">${escapeHtml(originalText)}</span>` : ''}
    `;

    subtitleOverlay.classList.remove('vidtrans-hidden');

    // Auto-hide after 4 seconds of silence
    clearTimeout(window.__vidtrans_hide_timeout);
    window.__vidtrans_hide_timeout = setTimeout(() => {
      if (subtitleOverlay && !subtitleOverlay.classList.contains('vidtrans-hidden')) {
        subtitleOverlay.classList.add('vidtrans-hidden');
      }
    }, 4000);
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

  // API Key save
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

  // Source language save
  sourceLangSelect.addEventListener('change', async (e) => {
    sourceLang = e.target.value;
    await chrome.storage.local.set({ [SOURCE_LANG_STORAGE]: sourceLang });
  });

  // Toggle translation
  toggleBtn.addEventListener('click', () => {
    if (!isRunning) {
      startTranslation();
    } else {
      stopTranslation();
    }
  });

  // ── Translation Control ────────────────────────────────────────────────────

  function startTranslation() {
    isRunning = true;
    toggleBtn.textContent = '⏸ TẮT DỊCH';
    toggleBtn.classList.add('active');
    transcriptBox.innerHTML = '';
    setStatus('Đang kết nối...', 'warning');

    createSubtitleOverlay();

    // Init TTS (pre-warm voices)
    getTTSQueue();

    chrome.runtime.sendMessage({
      type: 'START_TRANSLATION',
      sourceLang: sourceLang
    }, (response) => {
      if (response?.error) {
        setStatus(response.error, 'error');
      }
    });
  }

  function stopTranslation() {
    isRunning = false;
    toggleBtn.textContent = '▶ BẬT DỊCH';
    toggleBtn.classList.remove('active');
    setStatus('Đã dừng', 'idle');

    // Stop TTS
    if (ttsQueue) {
      ttsQueue.cancel();
    }

    // Hide subtitle
    if (subtitleOverlay) {
      subtitleOverlay.classList.add('vidtrans-hidden');
    }

    chrome.runtime.sendMessage({ type: 'STOP_TRANSLATION' });
  }

  // ── Message Listener ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOGGLE_PANEL') {
      container.style.display = container.style.display === 'none' ? 'block' : 'none';

    } else if (msg.type === 'UPDATE_TRANSCRIPT') {
      const { original, translated } = msg;

      // Update UI
      addTranscript(original, translated);
      updateSubtitle(original, translated);

      // TTS: speak Vietnamese translation
      if (isRunning && translated) {
        getTTSQueue().speak(translated);
      }

      // Update status
      if (isRunning) {
        setStatus('Đang phiên dịch...', 'active');
      }

    } else if (msg.type === 'UPDATE_TRANSCRIPT_ERROR') {
      addStatusMessage(msg.message, msg.isError);

      if (msg.isError) {
        setStatus(msg.message, 'error');
      } else {
        setStatus(msg.message, 'warning');
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
      setTimeout(() => {
        // Re-check: is our panel still in DOM?
        if (!document.getElementById('vidtrans-root')) {
          window.__vidtrans_ui_injected__ = false;
          // Re-inject not needed here — this script is injected fresh each nav
        }
      }, 1000);
    });

    // MutationObserver: detect if <video> appears/disappears
    const videoObserver = new MutationObserver(() => {
      // Could trigger re-init here if needed
    });
    videoObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Init Status ────────────────────────────────────────────────────────────
  if (apiKey) {
    setStatus('Sẵn sàng');
  } else {
    setStatus('Chưa có API Key', 'warning');
  }

})();
