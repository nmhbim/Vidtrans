// lib/groq-api.js

/**
 * @typedef {Object} TranslationResult
 * @property {string} original
 * @property {string} translated
 */

/**
 * @typedef {Object} TranscriptionResult
 * @property {string} text
 */

export class GroqClient {
  /**
   * @param {string} apiKey
   */
  constructor(apiKey) {
    if (!apiKey || !apiKey.startsWith('gsk_')) {
      throw new Error('Invalid Groq API Key format. Must start with gsk_');
    }
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.groq.com/openai/v1';
  }

  /**
   * Transcribe audio to text using Groq Whisper
   * @param {Blob} audioBlob - Audio blob (webm/opus format)
   * @returns {Promise<string>} Transcribed text
   */
  async transcribe(audioBlob) {
    const formData = new FormData();
    const filename = this._getAudioFilename(audioBlob);
    formData.append('file', audioBlob, filename);
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');
    formData.append('temperature', '0.2');

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const message = err.error?.message || `Groq STT Error: ${response.status}`;
      throw new Error(message);
    }

    const data = await response.json();
    return data.text?.trim() || '';
  }

  /**
   * Translate text to Vietnamese using Groq Llama
   * @param {string} text - Text to translate
   * @param {string} [sourceLang='en-US'] - Source language code
   * @returns {Promise<string>} Translated Vietnamese text
   */
  async translate(text, sourceLang = 'en-US') {
    if (!text || text.trim().length < 2) {
      return '';
    }

    const langMap = {
      'en-US': 'English', 'en-GB': 'English', 'ja-JP': 'Japanese',
      'ko-KR': 'Korean', 'zh-CN': 'Chinese', 'fr-FR': 'French',
      'de-DE': 'German', 'es-ES': 'Spanish'
    };

    const source = langMap[sourceLang] || 'English';

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: `Bạn là thông dịch viên chuyên nghiệp. Dịch cực kỳ ngắn gọn, tự nhiên từ ${source} sang tiếng Việt. CHỉ trả về bản dịch tiếng Việt, KHÔNG giải thích, KHÔNG thêm ngoặc kép, KHÔNG thêm gì khác.`
          },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
        max_tokens: 128,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const message = err.error?.message || `Groq Translate Error: ${response.status}`;
      throw new Error(message);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content?.trim() || '';
  }

  /**
   * Translate with retry on rate limit
   * @param {string} text
   * @param {string} sourceLang
   * @returns {Promise<string>}
   */
  async translateWithRetry(text, sourceLang = 'en-US') {
    const MAX_RETRIES = 3;
    let lastError;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.translate(text, sourceLang);
      } catch (err) {
        lastError = err;

        // Rate limit — exponential backoff
        if (err.message.includes('429') || err.message.includes('rate limit')) {
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`[GroqClient] Rate limited. Retry in ${delay}ms...`);
          await this._sleep(delay);
          continue;
        }

        // Other error — retry once
        if (attempt < MAX_RETRIES - 1) {
          await this._sleep(500);
          continue;
        }

        throw err;
      }
    }

    throw lastError;
  }

  /**
   * Get appropriate filename for audio blob
   * @param {Blob} blob
   * @returns {string}
   */
  _getAudioFilename(blob) {
    const type = blob.type;
    if (type.includes('webm') || type.includes('opus')) {
      return 'audio.webm';
    }
    if (type.includes('wav')) {
      return 'audio.wav';
    }
    if (type.includes('mp3') || type.includes('mpeg')) {
      return 'audio.mp3';
    }
    return 'audio.webm';
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
