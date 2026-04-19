// lib/utils.js

/**
 * Sleep utility
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Debounce - delay function execution until after wait ms have elapsed
 * @param {Function} fn - Function to debounce
 * @param {number} wait - Wait time in ms
 * @returns {Function}
 */
export function debounce(fn, wait) {
  let timeoutId = null;

  return function (...args) {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      fn.apply(this, args);
      timeoutId = null;
    }, wait);
  };
}

/**
 * Throttle - ensure function is called at most once per wait ms
 * @param {Function} fn - Function to throttle
 * @param {number} wait - Wait time in ms
 * @returns {Function}
 */
export function throttle(fn, wait) {
  let lastTime = 0;
  let timeoutId = null;

  return function (...args) {
    const now = Date.now();

    if (now - lastTime >= wait) {
      lastTime = now;
      fn.apply(this, args);
    } else {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        lastTime = Date.now();
        timeoutId = null;
        fn.apply(this, args);
      }, wait - (now - lastTime));
    }
  };
}

/**
 * Detect silence in audio using AnalyserNode
 * @param {AnalyserNode} analyser
 * @param {number} [threshold=0.01] - RMS threshold for silence
 * @returns {boolean}
 */
export function detectSilence(analyser, threshold = 0.01) {
  const data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatTimeDomainData(data);

  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  const rms = Math.sqrt(sum / data.length);
  return rms < threshold;
}

/**
 * Get MIME type for MediaRecorder
 * @returns {string}
 */
export function getBestMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];

  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }

  return '';
}

/**
 * Log with timestamp prefix
 * @param {...any} args
 */
export function log(...args) {
  const timestamp = new Date().toISOString().substr(11, 12);
  console.log(`[${timestamp}]`, ...args);
}

/**
 * Log error with timestamp prefix
 * @param {...any} args
 */
export function logError(...args) {
  const timestamp = new Date().toISOString().substr(11, 12);
  console.error(`[${timestamp}]`, ...args);
}
