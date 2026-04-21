/**
 * Minimal Edge TTS client for browser extensions
 * Implements the latest Edge TTS protocol with full voice names and robust error reporting
 */
export class EdgeTTS {
  constructor(voice = 'vi-VN-HoaiNinhNeural') {
    this.voice = voice;
    this.wsUrl = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  }

  _getFullVoiceName(shortName) {
    if (shortName.includes('HoaiMy')) return 'Microsoft Server Speech Text to Speech Voice (vi-VN, HoaiMyNeural)';
    if (shortName.includes('HoaiNinh')) return 'Microsoft Server Speech Text to Speech Voice (vi-VN, HoaiNinhNeural)';
    if (shortName.includes('NamMinh')) return 'Microsoft Server Speech Text to Speech Voice (vi-VN, NamMinhNeural)';
    return shortName;
  }

  async synthesize(text, rate = 1.0) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        console.log('[EdgeTTS] 🔌 Connecting to:', this.wsUrl);
        ws = new WebSocket(this.wsUrl);
      } catch (connErr) {
        return reject(new Error(`Không thể khởi tạo WebSocket: ${connErr.message}`));
      }

      const chunks = [];
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close();
          reject(new Error('Kết nối tới Microsoft quá hạn (Timeout)'));
        }
      }, 15000);

      ws.onopen = () => {
        const timestamp = new Date().toISOString();
        const configMsg = `Path: speech.config\r\nX-Timestamp: ${timestamp}\r\nContent-Type: application/json\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
        ws.send(configMsg);

        const prosodyRate = Math.round((rate - 1.0) * 100);
        const rateStr = prosodyRate >= 0 ? `+${prosodyRate}%` : `${prosodyRate}%`;
        const fullVoiceName = this._getFullVoiceName(this.voice);
        
        const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'><voice name='${fullVoiceName}'><prosody rate='${rateStr}'>${text}</prosody></voice></speak>`;
        const ssmlMsg = `Path: ssml\r\nX-Timestamp: ${timestamp}\r\nContent-Type: ssml+xml\r\n\r\n${ssml}`;
        ws.send(ssmlMsg);
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          if (event.data.includes('Path:turn.end')) {
            clearTimeout(timeout);
            ws.close();
            if (chunks.length > 0) {
              resolve(new Blob(chunks, { type: 'audio/mpeg' }));
            } else {
              reject(new Error('Microsoft không trả về dữ liệu âm thanh.'));
            }
          }
        } else {
          const data = new Uint8Array(event.data);
          const dataView = new DataView(data.buffer);
          const headerLength = dataView.getUint16(0);
          const audioData = data.slice(headerLength + 2);
          if (audioData.length > 0) {
            chunks.push(audioData);
          }
        }
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        console.error('[EdgeTTS] WebSocket Error:', err);
        // Onerror often doesn't provide a message, so we provide a descriptive one
        reject(new Error('Lỗi kết nối WebSocket (Có thể bị chặn bởi CSP hoặc Network)'));
      };

      ws.onclose = (e) => {
        clearTimeout(timeout);
        if (chunks.length === 0) {
          let reason = `Đóng kết nối (${e.code})`;
          if (e.code === 403) reason = 'Bị chặn (403 Forbidden). Hãy kiểm tra lại Header Spoofing.';
          if (e.code === 1006) reason = 'Kết nối bị ngắt đột ngột (1006). Kiểm tra mạng hoặc CSP.';
          reject(new Error(reason));
        }
      };
    });
  }
}
