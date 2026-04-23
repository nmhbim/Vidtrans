// lib/constants.js — Shared constants across all extension contexts

const LANG_NAMES = {
  vi: 'Vietnamese', en: 'English', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  fr: 'French', de: 'German', es: 'Spanish', ru: 'Russian', it: 'Italian',
  pt: 'Portuguese', th: 'Thai', id: 'Indonesian', ms: 'Malay', tl: 'Filipino',
  hi: 'Hindi', ar: 'Arabic', tr: 'Turkish', nl: 'Dutch', pl: 'Polish',
  sv: 'Swedish', da: 'Danish', fi: 'Finnish', el: 'Greek', cs: 'Czech',
  hu: 'Hungarian', ro: 'Romanian', uk: 'Ukrainian'
};

const STORAGE_KEYS = {
  API_KEY: 'vidtrans_groq_key',
  SOURCE_LANG: 'vidtrans_source_lang',
  PANEL_POS: 'vidtrans_panel_pos',
  TTS_RATE: 'vidtrans_tts_rate',
  TTS_VOICE: 'vidtrans_tts_voice',
  TTS_ENGINE: 'vidtrans_tts_engine',
  SUBTITLE_POS: 'vidtrans_subtitle_pos',
};

// Make globally available for content scripts + offscreen
if (typeof window !== 'undefined') {
  window.LANG_NAMES = LANG_NAMES;
  window.STORAGE_KEYS = STORAGE_KEYS;
}
