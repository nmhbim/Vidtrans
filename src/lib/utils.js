/**
 * Common utilities
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
export async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
