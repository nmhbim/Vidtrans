/**
 * Common utilities
 */

/**
 * Escapes HTML characters. 
 * Works in both DOM (Content Script) and Non-DOM (Service Worker) environments.
 */
export function escapeHtml(text: string): string {
  if (typeof document !== 'undefined') {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  // Fallback for Service Workers
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
