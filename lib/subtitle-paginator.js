/**
 * SubtitlePaginator — Splits long subtitle text into 2-line pages
 * and advances pages based on TTS word boundary events.
 *
 * Shared by both Edge TTS and Native TTS pipelines.
 *
 * Usage:
 *   const paginator = new SubtitlePaginator(overlayElement, {
 *     maxLines: 2,
 *     charsPerLine: 45,   // approximate chars before wrapping
 *   });
 *
 *   paginator.setText(fullText);       // sets full text, shows page 1
 *   paginator.onWordBoundary(offset);  // advance page when reading passes boundary
 *   paginator.clear();                 // reset
 */
class SubtitlePaginator {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxLines=2]       - Max visible lines
   * @param {number} [options.charsPerLine=45]  - Approximate chars per line for page splitting
   */
  constructor(options = {}) {
    /** @type {number} */
    this.maxLines = options.maxLines || 2;

    /** @type {number} */
    this.charsPerLine = options.charsPerLine || 45;

    /** @type {string} */
    this._fullText = '';

    /** @type {string[]} */
    this._pages = [];

    /** @type {number[]} page boundary char offsets — _pageBoundaries[i] = start char index of page i */
    this._pageBoundaries = [];

    /** @type {number} */
    this._currentPage = 0;

    /** @type {string} */
    this._originalText = '';
  }

  /**
   * Set new text to paginate. Immediately shows the first page.
   * @param {string} fullText    - The full translated text
   * @param {string} [original]  - Original text (for secondary display)
   * @returns {{ page: string, pageIndex: number, totalPages: number }}
   */
  setText(fullText, original = '') {
    this._fullText = fullText || '';
    this._originalText = original || '';
    this._currentPage = 0;

    this._splitIntoPages();

    return this.getCurrentPage();
  }

  /**
   * Called when a word boundary event fires.
   * Checks if the reading position has moved past the current page boundary.
   *
   * @param {number} charOffset - Character offset in the full text (textOffset from word boundary)
   * @returns {{ page: string, pageIndex: number, totalPages: number, changed: boolean }}
   */
  onWordBoundary(charOffset) {
    if (this._pages.length <= 1) {
      return { ...this.getCurrentPage(), changed: false };
    }

    // Find which page this offset belongs to
    let targetPage = 0;
    for (let i = 0; i < this._pageBoundaries.length; i++) {
      if (charOffset >= this._pageBoundaries[i]) {
        targetPage = i;
      }
    }

    if (targetPage !== this._currentPage) {
      this._currentPage = targetPage;
      return { ...this.getCurrentPage(), changed: true };
    }

    return { ...this.getCurrentPage(), changed: false };
  }

  /**
   * Advance to the next page manually (fallback when no word boundaries).
   * @returns {{ page: string, pageIndex: number, totalPages: number, changed: boolean }}
   */
  nextPage() {
    if (this._currentPage < this._pages.length - 1) {
      this._currentPage++;
      return { ...this.getCurrentPage(), changed: true };
    }
    return { ...this.getCurrentPage(), changed: false };
  }

  /**
   * Get the current page content.
   * @returns {{ page: string, pageIndex: number, totalPages: number }}
   */
  getCurrentPage() {
    const page = this._pages[this._currentPage] || this._fullText;
    return {
      page,
      pageIndex: this._currentPage,
      totalPages: this._pages.length,
    };
  }

  /**
   * Whether the full text needs pagination (i.e. more than 1 page).
   * @returns {boolean}
   */
  get needsPagination() {
    return this._pages.length > 1;
  }

  /**
   * Get the original text associated with the current text.
   * @returns {string}
   */
  get originalText() {
    return this._originalText;
  }

  /**
   * Get the full text.
   * @returns {string}
   */
  get fullText() {
    return this._fullText;
  }

  /**
   * Reset all state.
   */
  clear() {
    this._fullText = '';
    this._originalText = '';
    this._pages = [];
    this._pageBoundaries = [];
    this._currentPage = 0;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Split the full text into pages of maxLines lines each.
   * Uses word-aware wrapping to avoid splitting mid-word.
   */
  _splitIntoPages() {
    const text = this._fullText.trim();
    if (!text) {
      this._pages = [''];
      this._pageBoundaries = [0];
      return;
    }

    // Step 1: Wrap text into lines of ~charsPerLine
    const lines = this._wrapText(text);

    // Step 2: Group lines into pages of maxLines each
    this._pages = [];
    this._pageBoundaries = [];

    for (let i = 0; i < lines.length; i += this.maxLines) {
      const pageLines = lines.slice(i, i + this.maxLines);
      const pageText = pageLines.map(l => l.text).join('\n');
      this._pages.push(pageText);
      this._pageBoundaries.push(pageLines[0].offset);
    }

    // Ensure at least 1 page
    if (this._pages.length === 0) {
      this._pages = [text];
      this._pageBoundaries = [0];
    }
  }

  /**
   * Wrap text into lines, tracking the character offset for each line.
   * Splits on word boundaries to avoid cutting mid-word.
   *
   * @param {string} text
   * @returns {Array<{text: string, offset: number}>}
   */
  _wrapText(text) {
    // For CJK (Chinese, Japanese, Korean, Thai), each character is roughly
    // one "word" and can wrap anywhere. For Latin scripts, wrap on spaces.
    const isCJK = /[\u3000-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/.test(text);

    if (isCJK) {
      return this._wrapCJK(text);
    }

    return this._wrapLatin(text);
  }

  /**
   * Wrap Latin-script text on spaces.
   * @param {string} text
   * @returns {Array<{text: string, offset: number}>}
   */
  _wrapLatin(text) {
    const words = text.split(/(\s+)/);
    const lines = [];
    let currentLine = '';
    let currentLineOffset = 0;
    let charPos = 0;

    for (const segment of words) {
      const testLine = currentLine + segment;

      if (testLine.trim().length > this.charsPerLine && currentLine.trim().length > 0) {
        // Current line is full, push it
        lines.push({ text: currentLine.trim(), offset: currentLineOffset });
        currentLine = segment.trimStart();
        currentLineOffset = charPos;
        // Adjust offset to skip leading whitespace
        if (segment !== currentLine) {
          currentLineOffset += segment.length - currentLine.length;
        }
      } else {
        if (currentLine.length === 0) {
          currentLineOffset = charPos;
        }
        currentLine = testLine;
      }

      charPos += segment.length;
    }

    if (currentLine.trim().length > 0) {
      lines.push({ text: currentLine.trim(), offset: currentLineOffset });
    }

    return lines;
  }

  /**
   * Wrap CJK text by character count.
   * @param {string} text
   * @returns {Array<{text: string, offset: number}>}
   */
  _wrapCJK(text) {
    // CJK characters are wider, so use fewer chars per line
    const cjkCharsPerLine = Math.floor(this.charsPerLine * 0.6);
    const lines = [];

    for (let i = 0; i < text.length; i += cjkCharsPerLine) {
      const lineText = text.substring(i, i + cjkCharsPerLine);
      lines.push({ text: lineText, offset: i });
    }

    return lines;
  }
}

window.SubtitlePaginator = SubtitlePaginator;
