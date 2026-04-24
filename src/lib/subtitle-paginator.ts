/**
 * SubtitlePaginator — Splits long subtitle text into 2-line pages
 * and advances pages based on TTS word boundary events.
 */

interface PaginatorOptions {
  maxLines?: number;
  charsPerLine?: number;
}

interface PageInfo {
  page: string;
  pageIndex: number;
  totalPages: number;
  changed?: boolean;
}

interface LineInfo {
  text: string;
  offset: number;
}

export class SubtitlePaginator {
  maxLines: number;
  charsPerLine: number;
  private _fullText: string = '';
  private _pages: string[] = [];
  private _pageBoundaries: number[] = [];
  private _currentPage: number = 0;
  private _originalText: string = '';

  constructor(options: PaginatorOptions = {}) {
    this.maxLines = options.maxLines || 2;
    this.charsPerLine = options.charsPerLine || 45;
  }

  setText(fullText: string, original = ''): PageInfo {
    this._fullText = fullText || '';
    this._originalText = original || '';
    this._currentPage = 0;

    this._splitIntoPages();

    return this.getCurrentPage();
  }

  onWordBoundary(charOffset: number): PageInfo {
    if (this._pages.length <= 1) {
      return { ...this.getCurrentPage(), changed: false };
    }

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

  nextPage(): PageInfo {
    if (this._currentPage < this._pages.length - 1) {
      this._currentPage++;
      return { ...this.getCurrentPage(), changed: true };
    }
    return { ...this.getCurrentPage(), changed: false };
  }

  getCurrentPage(): PageInfo {
    const page = this._pages[this._currentPage] || this._fullText;
    return {
      page,
      pageIndex: this._currentPage,
      totalPages: this._pages.length,
    };
  }

  get needsPagination(): boolean {
    return this._pages.length > 1;
  }

  get originalText(): string {
    return this._originalText;
  }

  get fullText(): string {
    return this._fullText;
  }

  clear() {
    this._fullText = '';
    this._originalText = '';
    this._pages = [];
    this._pageBoundaries = [];
    this._currentPage = 0;
  }

  private _splitIntoPages() {
    const text = this._fullText.trim();
    if (!text) {
      this._pages = [''];
      this._pageBoundaries = [0];
      return;
    }

    const lines = this._wrapText(text);

    this._pages = [];
    this._pageBoundaries = [];

    for (let i = 0; i < lines.length; i += this.maxLines) {
      const pageLines = lines.slice(i, i + this.maxLines);
      const pageText = pageLines.map(l => l.text).join('\n');
      this._pages.push(pageText);
      this._pageBoundaries.push(pageLines[0].offset);
    }

    if (this._pages.length === 0) {
      this._pages = [text];
      this._pageBoundaries = [0];
    }
  }

  private _wrapText(text: string): LineInfo[] {
    const isCJK = /[\u3000-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/.test(text);
    if (isCJK) {
      return this._wrapCJK(text);
    }
    return this._wrapLatin(text);
  }

  private _wrapLatin(text: string): LineInfo[] {
    const words = text.split(/(\s+)/);
    const lines: LineInfo[] = [];
    let currentLine = '';
    let currentLineOffset = 0;
    let charPos = 0;

    for (const segment of words) {
      const testLine = currentLine + segment;

      if (testLine.trim().length > this.charsPerLine && currentLine.trim().length > 0) {
        lines.push({ text: currentLine.trim(), offset: currentLineOffset });
        currentLine = segment.trimStart();
        currentLineOffset = charPos;
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

  private _wrapCJK(text: string): LineInfo[] {
    const cjkCharsPerLine = Math.floor(this.charsPerLine * 0.6);
    const lines: LineInfo[] = [];

    for (let i = 0; i < text.length; i += cjkCharsPerLine) {
      const lineText = text.substring(i, i + cjkCharsPerLine);
      lines.push({ text: lineText, offset: i });
    }

    return lines;
  }
}
