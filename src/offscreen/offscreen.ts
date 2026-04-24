import { GroqClient } from '../lib/groq-api';
import { TTSController } from '../lib/tts-controller';

// offscreen.ts
// Audio capture + STT/Translation pipeline — runs in hidden Offscreen Document

const CHUNK_INTERVAL_MS = 6000;

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let mediaRecorder: MediaRecorder | null = null;
let groqClient: GroqClient | null = null;
let apiKey: string = '';
let targetLang: string = 'vi';
let isTranslating: boolean = false;
let translationContext: string[] = [];

const ttsController = new TTSController({
  onPlaybackStart: () => {
    chrome.runtime.sendMessage({ type: 'TTS_STATE_CHANGED', playing: true });
  },
  onPlaybackEnd: () => {
    chrome.runtime.sendMessage({ type: 'TTS_STATE_CHANGED', playing: false });
  },
  onError: (errMsg) => {
    chrome.runtime.sendMessage({
      type: 'UPDATE_TRANSCRIPT_ERROR',
      message: `TTS Error: ${errMsg}`,
      isError: true
    });
  }
});

ttsController.setWordBoundaryListener((wb, audio) => {
  chrome.runtime.sendMessage({
    type: 'TTS_WORD_BOUNDARY',
    word: wb.text,
    offsetMs: wb.offsetMs,
    durationMs: wb.durationMs,
    textOffset: wb.textOffset,
    textLength: wb.textLength,
    audioTimeMs: audio ? audio.currentTime * 1000 : 0,
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'CONSUME_STREAM':
      handleConsumeStream(msg.streamId);
      sendResponse({ success: true });
      break;
    case 'START_TRANSLATION':
      apiKey = msg.apiKey;
      targetLang = msg.targetLang || 'vi';
      startTranslation();
      sendResponse({ success: true });
      break;
    case 'STOP_TRANSLATION':
      stopTranslation();
      sendResponse({ success: true });
      break;
    case 'SPEAK_SUBTITLE':
      if (msg.text?.trim()) ttsController.enqueue(msg.text);
      sendResponse({ success: true });
      break;
  }
  return true;
});

async function handleConsumeStream(streamId: string) {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      } as any,
      video: false,
    });

    audioContext = new AudioContext();
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(audioContext.destination);
  } catch (err) {
    console.error('[Offscreen] MediaStream failed:', err);
  }
}

async function startTranslation() {
  if (!mediaStream || !apiKey) return;
  groqClient = new GroqClient(apiKey, targetLang);
  isTranslating = true;
  recordNextChunk();
}

function stopTranslation() {
  isTranslating = false;
  ttsController.stop();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function recordNextChunk() {
  if (!isTranslating || !mediaStream) return;

  mediaRecorder = new MediaRecorder(mediaStream);
  let chunkBlobs: Blob[] = [];

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunkBlobs.push(event.data);
  };

  mediaRecorder.onstop = async () => {
    if (!isTranslating) return;
    const audioBlob = new Blob(chunkBlobs, { type: mediaRecorder?.mimeType });
    processAudioChunk(audioBlob);
    recordNextChunk();
  };

  mediaRecorder.start();
  setTimeout(() => {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  }, CHUNK_INTERVAL_MS);
}

async function processAudioChunk(audioBlob: Blob) {
  if (!groqClient || !isTranslating) return;
  try {
    const originalText = await groqClient.transcribe(audioBlob);
    if (!originalText) return;

    const translatedText = await groqClient.translate(originalText);
    
    chrome.runtime.sendMessage({
      type: 'UPDATE_TRANSCRIPT',
      original: originalText,
      translated: translatedText
    });

    ttsController.enqueue(translatedText);
  } catch (err) {
    console.error('[Offscreen] Pipeline error:', err);
  }
}
