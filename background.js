// FE Export — service worker.
//
// Chrome slows a background tab's timers down (1 per second, and after five hidden
// minutes 1 per minute for chained timers). The content script's waits ran on those
// timers, so the run stalled whenever the FullEnrich tab was not in front. The
// service worker is not throttled that way, so the content script asks it to wake
// it up: "sleep for N ms" is answered from here. Nothing else runs here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'sleep') {
    const ms = Math.max(0, Math.min(25000, Number(msg.ms) || 0));
    setTimeout(() => { try { sendResponse({ ok: true }); } catch (e) { /* port gone */ } }, ms);
    return true;
  }
  return false;
});
