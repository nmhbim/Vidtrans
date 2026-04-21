import { BaseTTS } from './base-tts.js';

export class EdgeTTS extends BaseTTS {
  constructor() {
    super();
    this.ws = null;
    this.currentAudio = null;
    this.mediaSource = null;
    this.isCompleted = false;
    this.timeout = null;
  }

  get id() { return 'edge'; }
  get name() { return 'Microsoft Edge (Online)'; }

  async init() {
    // We don't pre-connect because we need the connection per synthesis
  }

  async _getSecMsGec() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_EDGE_TOKEN' }, (response) => {
        resolve(response?.token || '');
      });
    });
  }

  _generateConnectionId() {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16).toUpperCase();
    });
  }

  _getFullVoiceName(shortName) {
    return shortName || 'vi-VN-HoaiMyNeural'; 
  }

  async speak(text, rate, voiceName) {
    this.stop(); // Stop any ongoing synthesis

    return new Promise(async (resolve, reject) => {
      try {
        const token = await this._getSecMsGec();
        const connectionId = this._generateConnectionId();
        const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=1-143.0.3650&ConnectionId=${connectionId}`;

        console.log('[EdgeTTS] 🚀 Connecting to:', wsUrl);

        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';
        
        this.isCompleted = false;

        this.timeout = setTimeout(() => {
          if (!this.isCompleted && this.ws.readyState !== WebSocket.CLOSED) {
            this.isCompleted = true;
            this.ws.close();
            reject(new Error('Kết nối tới Microsoft quá hạn (Timeout)'));
          }
        }, 15000);

        this.ws.onerror = (err) => {
          if (!this.isCompleted) {
            this.isCompleted = true;
            clearTimeout(this.timeout);
            reject(new Error('Lỗi kết nối WebSocket (Bị chặn 403 hoặc mất mạng)'));
          }
        };

        this.ws.onclose = (e) => {
          if (!this.isCompleted) {
            this.isCompleted = true;
            clearTimeout(this.timeout);
            if (e.code !== 1000 && e.code !== 1005) {
               reject(new Error(`Bị ngắt kết nối (Code ${e.code})`));
            } else {
               // Normal close but finished? If mediaSource is still appending, we shouldn't resolve yet.
               // We will resolve via the Audio element's onended event below.
            }
          }
        };

        // --- Setup MSE for Playback ---
        this.currentAudio = new Audio();
        this.mediaSource = new MediaSource();
        this.currentAudio.src = URL.createObjectURL(this.mediaSource);
        let queue = [];
        let sourceBuffer = null;
        let isAppending = false;
        let wsFinished = false;

        const processQueue = () => {
          if (queue.length > 0 && !isAppending && sourceBuffer && sourceBuffer.updating === false) {
            isAppending = true;
            sourceBuffer.appendBuffer(queue.shift());
          }
        };

        this.mediaSource.onsourceopen = () => {
          sourceBuffer = this.mediaSource.addSourceBuffer('audio/mpeg');
          sourceBuffer.onupdateend = () => {
            isAppending = false;
            processQueue();
            if (this.mediaSource.readyState === 'open' && queue.length === 0 && wsFinished) {
              this.mediaSource.endOfStream();
            }
          };
        };

        this.currentAudio.onended = () => {
          URL.revokeObjectURL(this.currentAudio.src);
          resolve(); // Resolve the promise ONLY when audio fully finishes playing
        };

        this.currentAudio.onerror = (e) => {
          reject(new Error(`Audio playback error: ${this.currentAudio.error?.message}`));
        };

        // --- Setup WS Handlers ---
        this.ws.onopen = () => {
          console.log('[EdgeTTS] ✅ WebSocket Connected');
          const timestamp = new Date().toUTCString();
          
          const configMsg = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
          this.ws.send(configMsg);

          const prosodyRate = Math.round((rate - 1.0) * 100);
          const rateStr = prosodyRate >= 0 ? `+${prosodyRate}%` : `${prosodyRate}%`;
          const fullVoiceName = this._getFullVoiceName(voiceName);
          
          const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'><voice name='${fullVoiceName}'><prosody rate='${rateStr}'>${text}</prosody></voice></speak>`;
          
          const ssmlMsg = `X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n${ssml}`;
          this.ws.send(ssmlMsg);
        };

        this.ws.onmessage = (event) => {
          if (typeof event.data === 'string') {
            if (event.data.includes('Path:turn.end')) {
              console.log('[EdgeTTS] 🔚 Synthesis finished');
              wsFinished = true;
              if (queue.length === 0 && !isAppending && this.mediaSource.readyState === 'open') {
                this.mediaSource.endOfStream();
              }
              if (!this.isCompleted) {
                this.isCompleted = true;
                clearTimeout(this.timeout);
                this.ws.close();
              }
            }
          } else {
            const data = new Uint8Array(event.data);
            const dataView = new DataView(data.buffer);
            const headerLength = dataView.getUint16(0);
            const audioData = data.slice(headerLength + 2);
            if (audioData.length > 0) {
              queue.push(audioData);
              processQueue();
              if (this.currentAudio.paused) this.currentAudio.play().catch(e => console.error('[EdgeTTS] Play error:', e));
            }
          }
        };

      } catch (err) {
        reject(err);
      }
    });
  }

  stop() {
    if (this.ws) {
      this.isCompleted = true;
      clearTimeout(this.timeout);
      if (this.ws.readyState !== WebSocket.CLOSED) {
        this.ws.close();
      }
      this.ws = null;
    }
    
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }
  }
}
