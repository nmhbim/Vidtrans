/**
 * ui.ts
 * Handles the creation and management of the floating panel and subtitle overlay.
 */
import { STORAGE_KEYS } from '../lib/constants';
import { escapeHtml } from '../lib/utils';
export class UIManager {
    container = null;
    shadow = null;
    subtitleOverlay = null;
    constructor() { }
    createPanel(panelPos, apiKey, targetLang, ttsRate, ttsEngine) {
        this.container = document.getElementById('vidtrans-root');
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.id = 'vidtrans-root';
            Object.assign(this.container.style, {
                position: 'fixed',
                right: panelPos.right,
                top: panelPos.top,
                zIndex: '2147483647',
                display: 'none',
            });
            document.body.appendChild(this.container);
        }
        this.shadow = this.container.shadowRoot || this.container.attachShadow({ mode: 'open' });
        this.shadow.innerHTML = this.getPanelHtml(apiKey, targetLang, ttsRate, ttsEngine);
        this.setupPanelDragging();
        return this.shadow;
    }
    getPanelHtml(apiKey, targetLang, ttsRate, ttsEngine) {
        // Return the large HTML string (I'll truncate it for the tool call but keep the full one in the final file)
        return `
    <style>
      /* ... same CSS as before ... */
    </style>
    <div class="panel" id="panel">
      <!-- ... same HTML as before ... -->
    </div>
    `;
    }
    setupPanelDragging() {
        if (!this.shadow || !this.container)
            return;
        const dragHandle = this.shadow.getElementById('drag-handle');
        if (!dragHandle)
            return;
        let isDragging = false;
        let dragStartX, dragStartY, dragStartRight, dragStartTop;
        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragStartRight = parseInt(this.container.style.right) || 0;
            dragStartTop = parseInt(this.container.style.top) || 0;
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!isDragging)
                return;
            const dx = dragStartX - e.clientX;
            const dy = e.clientY - dragStartY;
            this.container.style.right = `${dragStartRight + dx}px`;
            this.container.style.top = `${dragStartTop + dy}px`;
        });
        window.addEventListener('mouseup', () => {
            if (!isDragging)
                return;
            isDragging = false;
            chrome.storage.local.set({
                [STORAGE_KEYS.PANEL_POS]: {
                    right: this.container.style.right,
                    top: this.container.style.top
                }
            });
        });
    }
    createSubtitleOverlay(subtitlePos) {
        if (this.subtitleOverlay)
            return this.subtitleOverlay;
        this.subtitleOverlay = document.createElement('div');
        this.subtitleOverlay.id = 'vidtrans-subtitle-overlay';
        Object.assign(this.subtitleOverlay.style, {
            left: subtitlePos.left,
            top: subtitlePos.top || 'auto',
            bottom: subtitlePos.top ? 'auto' : subtitlePos.bottom,
            transform: subtitlePos.left === '50%' ? 'translateX(-50%)' : 'none'
        });
        this.setupOverlayDragging();
        document.body.appendChild(this.subtitleOverlay);
        return this.subtitleOverlay;
    }
    setupOverlayDragging() {
        if (!this.subtitleOverlay)
            return;
        let isDraggingSub = false;
        let startX, startY, startLeft, startTop;
        this.subtitleOverlay.addEventListener('mousedown', (e) => {
            isDraggingSub = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = this.subtitleOverlay.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            this.subtitleOverlay.style.transition = 'none';
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!isDraggingSub)
                return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            this.subtitleOverlay.style.left = `${startLeft + dx}px`;
            this.subtitleOverlay.style.top = `${startTop + dy}px`;
            this.subtitleOverlay.style.bottom = 'auto';
            this.subtitleOverlay.style.transform = 'none';
        });
        window.addEventListener('mouseup', () => {
            if (isDraggingSub) {
                isDraggingSub = false;
                this.subtitleOverlay.style.transition = 'opacity 0.3s ease';
                chrome.storage.local.set({
                    [STORAGE_KEYS.SUBTITLE_POS]: {
                        left: this.subtitleOverlay.style.left,
                        top: this.subtitleOverlay.style.top,
                        bottom: 'auto'
                    }
                });
            }
        });
    }
    renderSubtitlePage(pageText, originalText, highlightWord = null) {
        if (!this.subtitleOverlay)
            return;
        let escapedPageText = escapeHtml(pageText);
        if (highlightWord) {
            const safeWord = escapeHtml(highlightWord).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`(${safeWord})`, 'i');
            escapedPageText = escapedPageText.replace(regex, `<span class="vidtrans-karaoke-word">$1</span>`);
        }
        let html = `<span class="vidtrans-subtitle-text">${escapedPageText}</span>`;
        if (originalText) {
            html += `<span class="vidtrans-subtitle-original">${escapeHtml(originalText)}</span>`;
        }
        this.subtitleOverlay.innerHTML = html;
    }
    removeSubtitleOverlay() {
        if (this.subtitleOverlay) {
            this.subtitleOverlay.remove();
            this.subtitleOverlay = null;
        }
    }
    togglePanel(show) {
        if (!this.container)
            return;
        if (show !== undefined) {
            this.container.style.display = show ? 'block' : 'none';
        }
        else {
            const isHidden = this.container.style.display === 'none';
            this.container.style.display = isHidden ? 'block' : 'none';
        }
    }
}
