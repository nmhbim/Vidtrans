/**
 * YouTube Subtitle Extractor
 *
 * Mimics yt-dlp's approach (yt_dlp/extractor/youtube/_video.py):
 * 1. Extract ytInitialPlayerResponse from page HTML
 * 2. Read captionTracks from captions.playerCaptionsTracklistRenderer
 * 3. Select best track: manual subs > auto subs, preferred lang > fallback
 * 4. Extract poToken + required params from baseUrl (NOT override them)
 * 5. Fetch timedtext JSON3 — with credentials from the live YouTube session
 *
 * Key insight from yt-dlp source (process_language):
 *   - baseUrl ALREADY contains: opi, xoaf, xowf, ip, expire, signature, key
 *   - We MUST keep those params — we only add: fmt, xosf, pot, potc, c, cver, tlang
 *   - poToken is bound to VIDEO ID — a new token needed per video
 *   - yt-dlp checks 'exp' in baseUrl query params to detect if poToken is required
 */
class YouTubeExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'YouTube';
  }

  canHandle(urlObj) {
    return urlObj.hostname.includes('youtube.com') || urlObj.hostname.includes('youtu.be');
  }

  async extract(url, lang = 'en') {
    try {
      const urlObj = new URL(url);
      let videoId = null;

      if (urlObj.hostname.includes('youtube.com')) {
        if (urlObj.pathname === '/watch') videoId = urlObj.searchParams.get('v');
        else if (urlObj.pathname.startsWith('/shorts/')) videoId = urlObj.pathname.split('/')[2];
        else if (urlObj.pathname.startsWith('/live/')) videoId = urlObj.pathname.split('/')[2];
        else if (urlObj.pathname.startsWith('/embed/')) videoId = urlObj.pathname.split('/')[2];
        else if (urlObj.pathname.startsWith('/v/')) videoId = urlObj.pathname.split('/')[2];
      } else if (urlObj.hostname.includes('youtu.be')) {
        videoId = urlObj.pathname.slice(1);
      }

      if (!videoId) return null;
      return await this._fetchYouTubeSubtitles(videoId, lang);
    } catch (e) {
      return null;
    }
  }

  // ─── Step 1: Extract ytInitialPlayerResponse ─────────────────────────────────

  /**
   * yt-dlp does exactly this: scans <script> tags for ytInitialPlayerResponse = {...}.
   * The player response contains captions.playerCaptionsTracklistRenderer.captionTracks[].
   */
  _extractPlayerResponse() {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      // yt-dlp pattern: ytInitialPlayerResponse = { ... };
      const match = text.match(
        /ytInitialPlayerResponse\s*=\s*({.+?})\s*[;,]\s*(?:var|if|window|function|for|\n|$)/
      );
      if (!match) continue;
      try {
        const data = JSON.parse(match[1]);
        // yt-dlp handles ytplayer.config wrapped responses too
        if (data.args && data.args.player_response) {
          const inner = data.args.player_response;
          return typeof inner === 'string' ? JSON.parse(inner) : inner;
        }
        if (data && (data.captions || data.videoDetails)) return data;
      } catch (_) { /* try next script */ }
    }
    return null;
  }

  // ─── Step 2: Extract visitorData (needed for poToken) ───────────────────────

  /**
   * yt-dlp reads visitorData from YouTube's page config for GVS PO Token requests.
   * For subtitles, the poToken is bound to the video ID — must be generated per video.
   *
   * yt-dlp uses BgUtils (browser) or invidious session for this.
   * We extract what we can from the live page instead.
   */
  _extractVisitorData() {
    // Pattern 1: parse ytcfg.get('VISITOR_DATA') or ytcfg.set({...})
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      // "VISITOR_DATA":"Cgt...==" or 'ytcfg.set' with visitorData
      const vdMatch = text.match(/"VISITOR_DATA"\s*:\s*"([^"]{20,})"/);
      if (vdMatch) return vdMatch[1];
      const ytcfgMatch = text.match(/ytcfg\.set\s*\(\s*({[^}]+})/s);
      if (ytcfgMatch) {
        try {
          const cfg = JSON.parse(ytcfgMatch[1]);
          if (cfg.VISITOR_DATA) return cfg.VISITOR_DATA;
        } catch (_) { }
      }
    }
    return null;
  }

  // ─── Step 3: Extract experiment flags from baseUrl ───────────────────────────

  /**
   * yt-dlp checks if 'exp' query param in baseUrl contains 'xpe' or 'xpv'.
   * If so, a poToken IS REQUIRED for the subtitle request.
   * We detect this the same way yt-dlp does.
   */
  _requiresPoToken(baseUrl) {
    try {
      const u = new URL(baseUrl.replace(/\\u0026/g, '&'));
      const expValues = u.searchParams.getAll('exp');
      return expValues.some(v => v.includes('xpe') || v.includes('xpv'));
    } catch (_) {
      return false;
    }
  }

  // ─── Step 4: Select best caption track ───────────────────────────────────────

  /**
   * Select best caption track — prioritize target language to avoid translation API costs.
   *
   * Priority order:
   *  1. Manual track in target language (best — native subs, no translation needed)
   *  2. ASR track in target language (auto-generated, still no translation needed)
   *  3. Manual English track (need translation)
   *  4. ASR English track (need translation)
   *  5. Any manual track
   *  6. First available track
   *
   * @returns {{track, needsTranslation: boolean}}
   */
  _selectTrack(tracks, targetLang) {
    const lang = targetLang.split('-')[0];

    // Try target language first — no translation needed if found
    const targetManual = tracks.find(t => t.languageCode === lang && !t.kind);
    if (targetManual) return { track: targetManual, needsTranslation: false };

    const targetAsr = tracks.find(t => t.languageCode.startsWith(lang));
    if (targetAsr) return { track: targetAsr, needsTranslation: false };

    // Fall back to English or any available — will need translation
    const fallback = (
      tracks.find(t => t.languageCode === 'en' && !t.kind) ||
      tracks.find(t => t.languageCode.startsWith('en')) ||
      tracks.find(t => !t.kind) ||
      tracks[0]
    );
    return { track: fallback, needsTranslation: true };
  }

  // ─── Step 5: Build subtitle URL (keeping yt-dlp's params intact) ─────────────

  /**
   * yt-dlp's process_language():
   *   - Takes baseUrl from captionTrack (already has: opi, xoaf, xowf, ip, expire, signature, key)
   *   - Adds: fmt=json3, xosf=[], pot=POT, potc=1, c=INNERTUBE_CLIENT_NAME, tlang (if trans)
   *
   * CRITICAL: We do NOT override existing params. We only ADD missing ones.
   * The baseUrl already contains the video-specific params — we must keep them.
   */
  _buildSubtitleUrl(baseUrl, clientName, targetLang, poToken, tlang = null) {
    const urlStr = baseUrl.replace(/\\u0026/g, '&');
    const u = new URL(urlStr);

    // Log the raw baseUrl params for debugging
    console.log('[YouTubeExtractor] Raw baseUrl params:', Object.fromEntries(u.searchParams.entries()));


    // NOTE: Do NOT add xosf= — empty param may cause YouTube to reject the request
    // (yt-dlp adds this only in specific contexts; the working URL from page doesn't have it)

    // poToken — potc before pot, then fmt (matches working URL param order)
    if (poToken) {
      u.searchParams.set('potc', '1');
      u.searchParams.set('pot', poToken);
    }

    // fmt=json3 after pot (matches working URL order)
    u.searchParams.set('fmt', 'json3');

    // Client params — only set if not already present in baseUrl
    if (!u.searchParams.has('xorb')) u.searchParams.set('xorb', '2');
    if (!u.searchParams.has('xobt')) u.searchParams.set('xobt', '3');
    if (!u.searchParams.has('xovt')) u.searchParams.set('xovt', '3');

    if (!u.searchParams.has('cbr')) u.searchParams.set('cbr', 'Chrome');
    if (!u.searchParams.has('cbrver')) u.searchParams.set('cbrver', '147.0.0.0');
    if (!u.searchParams.has('c')) u.searchParams.set('c', clientName || 'WEB');
    if (!u.searchParams.has('cver')) u.searchParams.set('cver', '2.20260416.01.00');
    if (!u.searchParams.has('cplayer')) u.searchParams.set('cplayer', 'UNIPLAYER');
    if (!u.searchParams.has('cos')) u.searchParams.set('cos', 'Windows');
    if (!u.searchParams.has('cosver')) u.searchParams.set('cosver', '10.0');
    if (!u.searchParams.has('cplatform')) u.searchParams.set('cplatform', 'DESKTOP');

    // tlang: set ONLY when YouTube auto-translation is explicitly requested
    // (Tier 2 / 4 in the pipeline). yt-dlp warns this can "damage" subtitles
    // in some formats, but for json3 + ASR it works reliably.
    if (tlang) {
      u.searchParams.set('tlang', tlang);
    }

    return u.toString();
  }

  // ─── Step 6: Fetch + parse timedtext JSON3 ───────────────────────────────────

  async _fetchSubtitle(enrichedUrl) {
    console.log('[YouTubeExtractor] Subtitle URL:', enrichedUrl);

    // Fetch from the live page's origin — credentials included so YouTube accepts it
    const response = await fetch(enrichedUrl, {
      credentials: 'include',
      headers: {
        'Accept': '*/*',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Referer': 'https://www.youtube.com',
      }
    });

    if (!response.ok) {
      console.error('[YouTubeExtractor] HTTP', response.status, response.statusText);
      return null;
    }

    const text = await response.text();
    if (!text || !text.trim().startsWith('{')) {
      console.error('[YouTubeExtractor] Not JSON3 response:', text.slice(0, 100));
      return null;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('[YouTubeExtractor] JSON parse failed:', e);
      return null;
    }

    if (!data || !Array.isArray(data.events) || data.events.length === 0) {
      console.warn('[YouTubeExtractor] No caption events in response');
      return null;
    }

    const rawEvents = data.events
      .filter(e => Array.isArray(e.segs) && e.segs.length > 0)
      .map(e => ({
        start: e.tStartMs || 0,
        duration: e.dDurationMs || 0,
        text: e.segs.map(s => s.utf8 || '').join('').trim(),
      }))
      .filter(e => e.text.length > 0);

    if (rawEvents.length === 0) return null;

    // ─── Sentence-based Overlapping Merge ─────────────────────────────────────
    // 1. Flatten into words to detect sentence boundaries
    const words = [];
    rawEvents.forEach((e, idx) => {
      e.text.split(/\s+/).forEach(word => {
        if (word.length > 0) words.push({ word, eventIdx: idx });
      });
    });

    // 2. Group words into sentences
    const sentences = [];
    let currentSentence = { words: [], startEventIdx: -1, endEventIdx: -1 };

    words.forEach((w, i) => {
      if (currentSentence.startEventIdx === -1) currentSentence.startEventIdx = w.eventIdx;
      currentSentence.words.push(w.word);
      currentSentence.endEventIdx = w.eventIdx;

      // Check for sentence end (punctuation)
      const isLastWord = i === words.length - 1;
      const isSentenceEnd = /[.!?]$/.test(w.word);

      if (isSentenceEnd || isLastWord) {
        sentences.push({
          text: currentSentence.words.join(' '),
          start: rawEvents[currentSentence.startEventIdx].start,
          end: rawEvents[currentSentence.endEventIdx].start + rawEvents[currentSentence.endEventIdx].duration
        });
        currentSentence = { words: [], startEventIdx: -1, endEventIdx: -1 };
      }
    });

    // 3. Group sentences into longer chunks (~8-10s) for the listener
    // Strategy: Make chunks sequential and gapless to ensure stable display.
    // Smaller chunks = faster Edge TTS synthesis = lower latency for first audio.
    const chunks = [];
    const TARGET_CHUNK_MS = 8000;
    let startIndex = 0;

    while (startIndex < sentences.length) {
      let endIndex = startIndex;
      let currentDuration = 0;

      while (endIndex < sentences.length) {
        const chunkStart = sentences[startIndex].start;
        const chunkEnd = sentences[endIndex].end;
        currentDuration = chunkEnd - chunkStart;
        if (currentDuration >= TARGET_CHUNK_MS) break;
        endIndex++;
      }

      if (endIndex === startIndex) endIndex++;
      if (endIndex > sentences.length) endIndex = sentences.length;

      const chunkSentences = sentences.slice(startIndex, endIndex);
      chunks.push({
        start: chunkSentences[0].start,
        // We will calculate final duration in the next step to ensure no gaps
        text: chunkSentences.map(s => s.text).join(' ')
      });

      startIndex = endIndex;
    }

    // 4. Finalize durations to be gapless (Next Start = Current End)
    const finalEvents = chunks.map((chunk, i) => {
      const nextChunk = chunks[i + 1];
      let duration;

      if (nextChunk) {
        // Extend duration to the start of the next chunk
        duration = nextChunk.start - chunk.start;
      } else {
        // For the last chunk, use its natural end or a reasonable default
        duration = 15000; // 15s default for the last tail
      }

      return {
        start: chunk.start,
        duration: Math.max(duration, 3000), // Minimum 3s to ensure visibility
        text: chunk.text
      };
    });

    console.log(`[YouTubeExtractor] 🟢 Created ${finalEvents.length} gapless sequential chunks.`);
    return finalEvents;
  }

  // ─── Main pipeline ────────────────────────────────────────────────────────────

  async _fetchYouTubeSubtitles(_videoId, lang = 'en') {
    const targetLang = lang.split('-')[0];

    // ── Priority 1: Native target-lang track from background-captured URL ─────
    // If pot-interceptor already captured a URL for target lang → use directly
    const capturedUrl = await this._getCapturedSubUrl(_videoId);
    if (capturedUrl) {
      const capturedLang = new URL(capturedUrl).searchParams.get('lang') || 'en';
      const isTargetLang = capturedLang.startsWith(targetLang);

      if (isTargetLang) {
        console.log(`[YouTubeExtractor] ✅ Tier 1: Captured URL already in target lang (${capturedLang})`);
        const events = await this._fetchSubtitle(capturedUrl);
        if (events) return { events, lang: capturedLang, needsTranslation: false };
      }

      // ── Priority 2: Try YouTube auto-translation (tlang) on captured URL ───
      // YouTube has its own translation engine — free, no API cost.
      // Add tlang=target to the captured URL to get YouTube's translation.
      console.log(`[YouTubeExtractor] 🔄 Tier 2: Trying YouTube auto-translation (tlang=${targetLang})`);
      try {
        const ytTransUrl = new URL(capturedUrl);
        ytTransUrl.searchParams.set('tlang', targetLang);
        const ytEvents = await this._fetchSubtitle(ytTransUrl.toString());
        if (ytEvents && ytEvents.length > 0) {
          console.log(`[YouTubeExtractor] ✅ Tier 2: YouTube auto-translated ${ytEvents.length} lines`);
          return { events: ytEvents, lang: targetLang, needsTranslation: false };
        }
      } catch (e) {
        console.warn('[YouTubeExtractor] Tier 2 (tlang) failed:', e.message);
      }

      // ── Priority 3: Use captured URL as-is → Groq will translate ─────────
      console.log(`[YouTubeExtractor] ⚠️ Tier 3: Using captured URL (${capturedLang}) → needs Groq translation`);
      const events = await this._fetchSubtitle(capturedUrl);
      if (events) return { events, lang: capturedLang, needsTranslation: true };
    }

    // ── Priority 4: Build URL from ytInitialPlayerResponse ───────────────────
    const playerResponse = this._extractPlayerResponse();
    if (!playerResponse?.captions) {
      console.error('[YouTubeExtractor] No captions in playerResponse');
      return null;
    }

    const pctr = playerResponse.captions.playerCaptionsTracklistRenderer;
    const tracks = pctr?.captionTracks || [];
    if (tracks.length === 0) {
      console.error('[YouTubeExtractor] No captionTracks available');
      return null;
    }

    // Check if YouTube can auto-translate to target lang
    const translationLanguages = pctr?.translationLanguages || [];
    const ytCanTranslate = translationLanguages.some(
      tl => tl.languageCode?.startsWith(targetLang)
    );
    console.log(`[YouTubeExtractor] YouTube can translate to ${targetLang}:`, ytCanTranslate);

    const clientName = playerResponse.streamingData?.clientName || 'WEB';
    const { track: selected, needsTranslation } = this._selectTrack(tracks, targetLang);
    if (!selected) {
      console.error('[YouTubeExtractor] No track selected');
      return null;
    }

    console.log(`[YouTubeExtractor] Selected: lang=${selected.languageCode} kind=${selected.kind || 'manual'} needsTranslation=${needsTranslation}`);

    const requiresPot = this._requiresPoToken(selected.baseUrl);
    let poToken = requiresPot ? this._extractPoTokenFromPage(_videoId) : null;
    if (requiresPot && !poToken) {
      console.warn('[YouTubeExtractor] poToken required but not found');
    }

    // If needsTranslation AND YouTube can do it → try tlang first (free!)
    if (needsTranslation && ytCanTranslate) {
      console.log(`[YouTubeExtractor] 🔄 Trying YouTube tlang=${targetLang} on playerResponse track`);
      const tlangUrl = this._buildSubtitleUrl(selected.baseUrl, clientName, targetLang, poToken, targetLang);
      const tlangEvents = await this._fetchSubtitle(tlangUrl);
      if (tlangEvents && tlangEvents.length > 0) {
        console.log(`[YouTubeExtractor] ✅ YouTube auto-translation OK: ${tlangEvents.length} lines`);
        return { events: tlangEvents, lang: targetLang, needsTranslation: false };
      }
    }

    // Build URL without tlang → caller (Groq) will translate if needed
    const enrichedUrl = this._buildSubtitleUrl(selected.baseUrl, clientName, targetLang, poToken, null);
    const events = await this._fetchSubtitle(enrichedUrl);
    if (!events) return null;

    return {
      events,
      lang: selected.languageCode,
      needsTranslation,
    };
  }


  // ─── Get subtitle URL captured by background webRequest ─────────────────────

  /**
   * Check two sources for a pre-captured valid subtitle URL:
   * 1. window.__ytCapturedSubUrl — set by pot-interceptor.js via background message
   * 2. Ask background directly via chrome.runtime.sendMessage
   */
  async _getCapturedSubUrl(videoId) {
    // Source 1: In-page cache (already received via message)
    const pageCache = window.__ytCapturedSubUrl;
    if (pageCache) {
      if (videoId && pageCache[videoId]) {
        console.log('[YouTubeExtractor] Captured URL from page cache (video match)');
        return pageCache[videoId];
      }
      // Any cached URL from same tab — pot is tab-session-scoped
      const any = Object.values(pageCache)[0];
      if (any) {
        console.log('[YouTubeExtractor] Captured URL from page cache (any video)');
        return any;
      }
    }

    // Source 2: Ask background (in case message arrived before listener was ready)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_CAPTURED_SUB_URL',
        videoId,
      });
      if (response?.url) {
        console.log('[YouTubeExtractor] Captured URL from background cache');
        // Populate page cache for future calls
        if (!window.__ytCapturedSubUrl) window.__ytCapturedSubUrl = {};
        window.__ytCapturedSubUrl[videoId] = response.url;
        return response.url;
      }
    } catch (_) {
      // Extension context may not be available in all frames
    }

    return null;
  }

  // ─── Extract poToken from the live YouTube page ──────────────────────────────


  /**
   * Extract poToken using a 3-tier approach:
   *
   * Tier 1 (BEST): Read from window.__ytCachedPot — populated by pot-interceptor.js
   *   which hooks window.fetch at document_start and captures pot from YouTube's
   *   own player subtitle requests. This gives us a 100% valid, fresh token.
   *
   * Tier 2: Scan existing timedtext URLs already on the page HTML.
   *
   * Tier 3: Scan script tags for capital-Ml token pattern.
   */
  _extractPoTokenFromPage(videoId) {
    // Tier 1: Interceptor cache (most reliable)
    const cache = window.__ytCachedPot;
    if (cache) {
      // Try exact video match first
      if (videoId && cache[videoId]) {
        console.log('[YouTubeExtractor] pot from interceptor cache (video match)');
        return cache[videoId];
      }
      // Fall back to any cached token (same session, same visitor data)
      const anyToken = Object.values(cache)[0];
      if (anyToken) {
        console.log('[YouTubeExtractor] pot from interceptor cache (any video)');
        return anyToken;
      }
    }

    // Tier 2: Extract from timedtext URLs already present in page HTML
    const html = document.documentElement.innerHTML;
    const timedtextPot = html.match(/timedtext[^"']*[?&]pot=([A-Za-z0-9_-]{60,200})/);
    if (timedtextPot) {
      console.log('[YouTubeExtractor] pot from timedtext URL in page HTML');
      return timedtextPot[1];
    }

    // Tier 3: Look for capital-Ml prefixed token in script tags
    // Real poTokens start with 'Ml' (capital M, lowercase l), ~110-160 chars
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      const mlMatch = text.match(/["']?(Ml[A-Za-z0-9_-]{80,180}={0,2})["']/);
      if (mlMatch) {
        console.log('[YouTubeExtractor] pot from script tag (Ml pattern)');
        return mlMatch[1];
      }
    }

    // Tier 4: any pot= param in page
    const potMatch = html.match(/[?&]pot=([A-Za-z0-9_-]{60,200})/);
    if (potMatch) {
      console.log('[YouTubeExtractor] pot from page HTML generic scan');
      return potMatch[1];
    }

    console.warn('[YouTubeExtractor] No poToken found — subtitle may fail if pot is required');
    return null;
  }
}

window.YouTubeExtractor = YouTubeExtractor;
