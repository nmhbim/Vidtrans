/**
 * Subtitle URL Hunter
 *
 * Strategy:
 * 1. "Force CC click" — silently click the CC button on YouTube player to force
 *    YouTube to generate a timedtext request with a valid pot token.
 * 2. Background script (webRequest listener) captures that URL and sends it back
 *    via chrome.runtime.onMessage {type: 'SUB_URL_CAPTURED'}.
 * 3. We cache it in window.__ytCapturedSubUrl[videoId] for the extractor to use.
 *
 * This runs at document_idle (after YouTube player has rendered).
 */
(function () {
  if (window.__ytSubHunterInstalled) return;
  window.__ytSubHunterInstalled = true;

  // Cache: videoId → valid timedtext URL (the one YouTube uses internally)
  window.__ytCapturedSubUrl = window.__ytCapturedSubUrl || {};

  // ── Listen for URL captured by background webRequest listener ──────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SUB_URL_CAPTURED' && message.url && message.videoId) {
      window.__ytCapturedSubUrl[message.videoId] = message.url;
      console.log('[SubHunter] ✅ Received captured URL for', message.videoId,
        '→', message.url.slice(0, 80) + '...');
    }
  });

  // ── Force CC click to trigger YouTube subtitle request ──────────────────────
  function forceYouTubeLoadSubtitles() {
    const ccButton = document.querySelector('.ytp-subtitles-button');
    if (!ccButton) {
      console.log('[SubHunter] No CC button found — video may have no subtitles');
      return;
    }

    const isCcOn = ccButton.getAttribute('aria-pressed') === 'true';

    if (!isCcOn) {
      console.log('[SubHunter] Clicking CC to trigger subtitle request...');
      ccButton.click();

      // Turn CC back off after 200ms — enough time for the request to fire.
      // Use 200ms instead of 50ms to be safe across slower connections.
      setTimeout(() => {
        // Re-query in case DOM changed
        const btn = document.querySelector('.ytp-subtitles-button');
        if (btn && btn.getAttribute('aria-pressed') === 'true') {
          btn.click();
          console.log('[SubHunter] CC turned back off');
        }
      }, 200);
    } else {
      console.log('[SubHunter] CC already on — background should capture URL automatically');
    }
  }

  // ── Wait for YouTube player to be ready before triggering ──────────────────
  // YouTube player takes a moment to render after page load.
  // We check every 500ms until we find the CC button, up to 10 seconds.
  let attempts = 0;
  const maxAttempts = 20; // 10 seconds

  const waitForPlayer = setInterval(() => {
    attempts++;
    const ccButton = document.querySelector('.ytp-subtitles-button');

    if (ccButton) {
      clearInterval(waitForPlayer);
      // Give player 500ms more to fully initialize before we click
      setTimeout(forceYouTubeLoadSubtitles, 500);
    } else if (attempts >= maxAttempts) {
      clearInterval(waitForPlayer);
      console.log('[SubHunter] Timeout waiting for YouTube player');
    }
  }, 500);

  // ── Also trigger on YouTube SPA navigation (yt-navigate-finish) ────────────
  window.addEventListener('yt-navigate-finish', () => {
    // Reset cache for new video
    window.__ytSubHunterInstalled = false;
    window.__ytCapturedSubUrl = {};

    // Re-run after navigation
    setTimeout(() => {
      window.__ytSubHunterInstalled = true;
      attempts = 0;
      const retry = setInterval(() => {
        attempts++;
        const ccButton = document.querySelector('.ytp-subtitles-button');
        if (ccButton) {
          clearInterval(retry);
          setTimeout(forceYouTubeLoadSubtitles, 500);
        } else if (attempts >= maxAttempts) {
          clearInterval(retry);
        }
      }, 500);
    }, 1500);
  });

})();
