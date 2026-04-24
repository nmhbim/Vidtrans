import { STORAGE_KEYS } from '../lib/constants';
import { SubtitleFetcher } from '../lib/subtitle-fetcher';
import { SubtitleSync } from '../lib/subtitle-sync';
import { YouTubeAdapter } from '../lib/adapters/youtube-adapter';
import { TTSBridge } from './bridge';
import { UIManager } from './ui';
import { StatusManager } from './status';
import { duckVideoVolume, restoreVideoVolume } from './audio';
class VidTransContent {
    apiKey = '';
    targetLang = 'vi';
    ttsRate = 1.3;
    ttsVoice = '';
    ttsEngine = 'edge';
    isRunning = false;
    mode = 'live';
    ui;
    status = null;
    tts;
    fetcher;
    sync;
    paginator = null;
    player = null;
    constructor() {
        this.ui = new UIManager();
        this.tts = new TTSBridge();
        this.fetcher = new SubtitleFetcher();
        this.sync = new SubtitleSync();
        this.init();
    }
    async init() {
        console.log('[VidTrans] 🚀 Content script initializing (TS version)...');
        const state = await chrome.storage.local.get([
            STORAGE_KEYS.API_KEY,
            STORAGE_KEYS.SOURCE_LANG,
            STORAGE_KEYS.TTS_RATE,
            STORAGE_KEYS.TTS_VOICE,
            STORAGE_KEYS.TTS_ENGINE,
            STORAGE_KEYS.PANEL_POS,
            STORAGE_KEYS.SUBTITLE_POS
        ]);
        this.apiKey = state[STORAGE_KEYS.API_KEY] || '';
        this.targetLang = state[STORAGE_KEYS.SOURCE_LANG] || 'vi';
        this.ttsRate = state[STORAGE_KEYS.TTS_RATE] || 1.3;
        this.ttsVoice = state[STORAGE_KEYS.TTS_VOICE] || '';
        this.ttsEngine = state[STORAGE_KEYS.TTS_ENGINE] || 'edge';
        const shadow = this.ui.createPanel(state[STORAGE_KEYS.PANEL_POS] || { right: '20px', top: '20px' }, this.apiKey, this.targetLang, this.ttsRate, this.ttsEngine);
        this.status = new StatusManager(shadow.getElementById('status-dot'), shadow.getElementById('status-text'), shadow.getElementById('transcript-box'));
        this.setupEventListeners(shadow);
        this.setupMessageListener();
        this.updateVoiceList();
    }
    setupEventListeners(shadow) {
        // ... setup click handlers for buttons in the shadow DOM ...
        shadow.getElementById('toggle-btn')?.addEventListener('click', () => this.toggleTranslation());
        shadow.getElementById('settings-btn')?.addEventListener('click', () => {
            shadow.getElementById('settings-panel')?.classList.toggle('active');
        });
        // ... etc ...
    }
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg.type === 'TOGGLE_PANEL') {
                this.ui.togglePanel(msg.show);
            }
            else if (msg.type === 'UPDATE_TRANSCRIPT') {
                this.handleTranscriptUpdate(msg);
            }
            else if (msg.type === 'TTS_STATE_CHANGED') {
                msg.playing ? duckVideoVolume() : restoreVideoVolume();
            }
            else if (msg.type === 'TTS_WORD_BOUNDARY') {
                this.handleWordBoundary(msg);
            }
            else if (msg.type === 'FORCE_STOP_TRANSLATION') {
                if (this.isRunning)
                    this.stopTranslation();
            }
        });
    }
    async toggleTranslation() {
        if (this.isRunning) {
            this.stopTranslation();
        }
        else {
            await this.startTranslation();
        }
    }
    async startTranslation() {
        if (!this.apiKey) {
            alert('Vui lòng nhập API Key!');
            return;
        }
        this.isRunning = true;
        this.updateToggleButton();
        this.ui.createSubtitleOverlay({ left: '50%', bottom: '80px' });
        await this.startTranslationMode();
    }
    stopTranslation() {
        this.isRunning = false;
        this.updateToggleButton();
        this.sync.stop();
        this.tts.stop();
        this.ui.removeSubtitleOverlay();
        if (this.player)
            this.player.destroy();
        chrome.runtime.sendMessage({ type: 'STOP_TRANSLATION' });
        this.status?.setStatus('Sẵn sàng');
    }
    async startTranslationMode() {
        const video = document.querySelector('video');
        if (!video) {
            this.status?.setStatus('Không tìm thấy video', 'error');
            this.isRunning = false;
            return;
        }
        // Initialize player adapter
        if (window.location.hostname.includes('youtube.com')) {
            this.player = new YouTubeAdapter(video);
            this.player.onStateChange = (state) => {
                if (state === 'pause')
                    this.tts.pause();
                if (state === 'play')
                    this.tts.resume();
                if (state === 'ended')
                    this.tts.stop();
            };
            this.player.bindEvents();
        }
        this.status?.setStatus('Đang quét phụ đề...', 'warning');
        const subs = await this.fetcher.fetchSubtitles(window.location.href, this.targetLang);
        if (subs && subs.events.length > 0) {
            this.mode = 'subtitles';
            await this.startSubtitleSync(video, subs);
        }
        else {
            this.mode = 'live';
            this.startLiveMode();
        }
    }
    async startSubtitleSync(video, subs) {
        // ... Port the progressive translation and sync logic here ...
        this.status?.setStatus('Đang dịch phụ đề...', 'active');
    }
    startLiveMode() {
        this.tts = new TTSBridge();
        chrome.runtime.sendMessage({
            type: 'START_TRANSLATION',
            apiKey: this.apiKey,
            targetLang: this.targetLang,
            ttsEngine: this.ttsEngine,
            ttsRate: this.ttsRate,
            ttsVoice: this.ttsVoice
        });
        this.status?.setStatus('Đang dịch trực tiếp', 'active');
    }
    // ... other methods ...
    updateToggleButton() {
        // ... update UI button state ...
    }
    updateVoiceList() {
        // ... update voice dropdown ...
    }
    handleTranscriptUpdate(msg) {
        const { original, translated } = msg;
        this.status?.addTranscript(original, translated);
        // ... update overlay ...
    }
    handleWordBoundary(msg) {
        if (this.paginator) {
            const result = this.paginator.onWordBoundary(msg.textOffset);
            this.ui.renderSubtitlePage(result.page, this.paginator.originalText, msg.word);
        }
    }
}
new VidTransContent();
