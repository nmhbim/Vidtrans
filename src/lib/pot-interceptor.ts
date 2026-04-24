/**
 * pot-interceptor.ts
 * Injected into YouTube page to capture poToken from the player's internal state.
 */

(function() {
  console.log('[VidTrans] 🍯 PO Token interceptor active');
  
  // Intercepting internal YouTube objects...
  // Usually this uses Object.defineProperty on window or specific YT objects.
  
  const originalJSONParse = JSON.parse;
  window.JSON.parse = function(text, reviver) {
    const data = originalJSONParse.call(this, text, reviver);
    
    // Check for poToken in various places
    try {
      if (data?.playerConfig?.args?.po_token) {
        console.log('[VidTrans] ✅ Captured poToken via JSON.parse');
        window.dispatchEvent(new CustomEvent('vidtrans_pot_found', { detail: data.playerConfig.args.po_token }));
      }
    } catch (e) {}
    
    return data;
  };
})();
