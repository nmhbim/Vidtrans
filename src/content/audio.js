/**
 * audio.ts
 * Handles video volume ducking for clear TTS playback.
 */
const videoVolumeMap = new Map();
let duckRefCount = 0;
export function duckVideoVolume() {
    duckRefCount++;
    console.log('[VidTrans] 🦆 Ducking requested, refCount:', duckRefCount);
    document.querySelectorAll('video').forEach(v => {
        if (!videoVolumeMap.has(v)) {
            videoVolumeMap.set(v, v.volume);
        }
        // Target 30% of original volume, minimum 0.05
        v.volume = Math.max(v.volume * 0.3, 0.05);
    });
}
export function restoreVideoVolume() {
    duckRefCount = Math.max(0, duckRefCount - 1);
    console.log('[VidTrans] 🦆 Restore requested, refCount:', duckRefCount);
    if (duckRefCount === 0) {
        videoVolumeMap.forEach((origVol, v) => {
            try {
                if (v && !v.paused && !v.ended) {
                    v.volume = origVol;
                }
            }
            catch (e) { }
        });
        videoVolumeMap.clear();
    }
}
