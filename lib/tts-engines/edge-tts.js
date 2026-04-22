import { BaseTTS } from './base-tts.js';

export class EdgeTTS extends BaseTTS {
  constructor() {
    super();
    this.ws = null;
    this.textQueue = [];
    this.isSynthesizing = false;
    this.audioQueue = [];
    this.isPlaying = false;
    this.currentText = '';
    this.activeRequests = {};
  }

  get id() { return 'edge'; }
  get name() { return 'Microsoft Edge (Online)'; }

  async _getSecMsGec() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_EDGE_TOKEN' }, (response) => {
        resolve(response?.token || '');
      });
    });
  }

  _generateId() {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16).toLowerCase();
    });
  }

  async _connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    const token = await this._getSecMsGec();
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${this._generateId()}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=1-143.0.3650.75`;
    
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const timestamp = Date.now();
        const configMsg = `X-Timestamp: ${timestamp}\r\n` +
                          `Content-Type: application/json; charset=utf-8\r\n` +
                          `Path: speech.config\r\n\r\n` +
                          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
        ws.send(configMsg);
        this.ws = ws;
        resolve(ws);
      };
      ws.onerror = () => reject(new Error('WS failed'));
      ws.onmessage = (e) => this._onMessage(e);
      ws.onclose = () => { this.ws = null; };
    });
  }

  _onMessage(event) {
    if (typeof event.data === 'string') {
      const msgRequestId = this._extractRequestId(event.data);
      if (msgRequestId && this.activeRequests[msgRequestId]) {
        if (event.data.includes('Path:turn.start')) {
          console.log(`[EdgeTTS] 🏁 Turn Start: ${msgRequestId}`);
        } else if (event.data.includes('Path:turn.end')) {
          console.log(`[EdgeTTS] 🔚 Turn End: ${msgRequestId}`);
          this.activeRequests[msgRequestId].onEnd();
        }
      }
    } else {
      const data = new Uint8Array(event.data);
      const headerLength = new DataView(data.buffer).getUint16(0);
      const headerStr = new TextDecoder().decode(data.slice(2, 2 + headerLength));
      const msgRequestId = this._extractRequestId(headerStr);
      
      if (msgRequestId && this.activeRequests[msgRequestId] && headerStr.includes('Path:audio')) {
        this.activeRequests[msgRequestId].onData(data.slice(headerLength + 2));
      }
    }
  }

  _extractRequestId(headerStr) {
    const match = headerStr.match(/X-RequestId:\s*([a-f0-9]+)/i);
    return match ? match[1].toUpperCase() : null;
  }

  async speak(text, rate, voiceName) {
    const normalizedText = text.replace(/\.\.+/g, '.').replace(/\. /g, ', ').trim();
    if (this.currentText === normalizedText) return;
    this.currentText = normalizedText;

    this.textQueue.push({ text: normalizedText, rate, voiceName });
    this._runSynthesisWorker();
    return Promise.resolve();
  }

  async _runSynthesisWorker() {
    if (this.isSynthesizing || this.textQueue.length === 0) return;
    this.isSynthesizing = true;

    while (this.textQueue.length > 0) {
      const item = this.textQueue.shift();
      try {
        const audioObj = await this._createStreamingAudio(item.text, item.rate, item.voiceName);
        if (!this.isSynthesizing) return;
        this.audioQueue.push(audioObj);
        this._runPlaybackWorker();
      } catch (err) {
        console.error('[EdgeTTS] Synthesis failed:', err);
      }
    }
    this.isSynthesizing = false;
  }

  async _createStreamingAudio(text, rate, voiceName) {
    const ws = await this._connect();
    const requestId = this._generateId().toUpperCase(); // Đồng bộ chữ HOA với server
    
    const audio = new Audio();
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    audio.src = objectUrl;

    return new Promise((resolve, reject) => {
      let sourceBuffer = null;
      let chunks = [];
      let isAppending = false;
      let isWsDone = false;
      let hasReceivedFirstChunk = false;

      const append = () => {
        if (chunks.length > 0 && !isAppending && sourceBuffer && !sourceBuffer.updating) {
          isAppending = true;
          sourceBuffer.appendBuffer(chunks.shift());
        }
      };

      this.activeRequests[requestId] = {
        onData: (data) => {
          chunks.push(data);
          append();
          if (!hasReceivedFirstChunk) {
            hasReceivedFirstChunk = true;
            console.log(`[EdgeTTS] ⚡ First chunk for ${requestId}`);
            resolve({ audio, objectUrl, requestId });
          }
        },
        onEnd: () => {
          isWsDone = true;
          if (sourceBuffer && !sourceBuffer.updating && chunks.length === 0) {
            try { mediaSource.endOfStream(); } catch(e){}
          }
          delete this.activeRequests[requestId];
        }
      };

  mediaSource.onsourceopen = () => {
        sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
        sourceBuffer.onupdateend = () => {
          isAppending = false;
          append();
          if (isWsDone && chunks.length === 0) {
            try { mediaSource.endOfStream(); } catch(e){}
          }
        };
        
        const timestamp = Date.now();
        const prosodyRate = Math.round((rate - 1.0) * 100);
        const rateStr = prosodyRate >= 0 ? `+${prosodyRate}%` : `${prosodyRate}%`;
        
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="vi-VN"><voice name="${voiceName || 'vi-VN-HoaiMyNeural'}"><prosody rate="${rateStr}">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</prosody></voice></speak>`;
        
        const ssmlMsg = `X-RequestId: ${requestId}\r\n` +
                        `Content-Type: application/ssml+xml\r\n` +
                        `X-Timestamp: ${timestamp}\r\n` +
                        `Path: ssml\r\n\r\n` +
                        ssml;
                        
        ws.send(ssmlMsg);
      };

      // Timeout nâng lên 15s
      setTimeout(() => {
        if (!hasReceivedFirstChunk) {
          delete this.activeRequests[requestId];
          reject(new Error(`Timeout waiting for first chunk (${requestId})`));
        }
      }, 15000);
    });
  }

  async _runPlaybackWorker() {
    if (this.isPlaying || this.audioQueue.length === 0) return;
    this.isPlaying = true;

    // Trigger onStart if this is the beginning of a playback sequence
    if (typeof this.onStart === 'function') {
      this.onStart();
    }

    while (this.audioQueue.length > 0) {
      const { audio, objectUrl, requestId } = this.audioQueue.shift();
      console.log(`[EdgeTTS] 🔊 Playing segment: ${requestId}`);
      try {
        await new Promise((resolve) => {
          audio.onended = () => { URL.revokeObjectURL(objectUrl); resolve(); };
          audio.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(); };
          audio.play().catch(resolve);
        });
      } catch (err) {
        console.error('[EdgeTTS] Playback error', err);
      }
    }
    
    this.isPlaying = false;
    
    // Trigger onEnd when queue is empty and playback stops
    if (typeof this.onEnd === 'function') {
      this.onEnd();
    }
  }

  stop() {
    this.textQueue = [];
    this.audioQueue.forEach(item => {
      item.audio.pause();
      URL.revokeObjectURL(item.objectUrl);
    });
    this.audioQueue = [];
    this.isSynthesizing = false;
    this.isPlaying = false;
    
    if (typeof this.onEnd === 'function') {
      this.onEnd();
    }
  }
}

