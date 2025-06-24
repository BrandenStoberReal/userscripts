// ==UserScript==
// @name         Reddit → Wayback auto-archiver
// @namespace    reddit-wayback-autosave
// @version      1.6.5
// @description  Auto-submit every Reddit post you visit to the Wayback Machine (works with SPA navigation).
// @author       Branden Stober (fixed by AI)
// @updateURL    https://raw.githubusercontent.com/BrandenStoberReal/userscripts/main/autoarchivereddit.user.js
// @downloadURL  https://raw.githubusercontent.com/BrandenStoberReal/userscripts/main/autoarchivereddit.user.js
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @match        https://np.reddit.com/*
// @match        https://redd.it/*
// @icon         https://www.redditstatic.com/desktop2x/img/favicon/apple-icon-57x57.png
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @grant        GM.addStyle
// @connect      web.archive.org
// @run-at       document-start
// ==/UserScript==

(() => {
  /* ========== USER SETTINGS ========== */
  const COOLDOWN_HOURS  = 24;
  const ENABLED_DEFAULT = true;
  const DEBUG_LOGGING   = true;
  /* =================================== */

  /* ---------- tiny helpers ---------- */
  const HOUR       = 36e5;
  const KEY_GLOBAL = '_enabled';
  const KEY_QUEUE = '_archive_queue';
  const KEY_LAST_URL = '_last_url';
  const store = {
    get: (k, d) => GM.getValue(k, d),
    set: (k, v) => GM.setValue(k, v)
  };
  const log = (...a) => DEBUG_LOGGING && console.log('[Wayback-archiver]', ...a);

  /* ---------- little toast ---------- */
  GM.addStyle(`
   .wb-toast{position:fixed;bottom:20px;right:20px;max-width:260px;padding:8px 12px;
    font:13px/17px system-ui,sans-serif;color:#fff;background:#323232e6;border-radius:4px;
    box-shadow:0 2px 4px rgba(0,0,0,.35);opacity:0;transform:translateY(10px);
    transition:opacity .25s,transform .25s;z-index:2147483647;pointer-events:none}
   .wb-toast.show{opacity:1;transform:translateY(0)}
  `);

  function showToast(msg, ms = 3500) {
    if (!document.body) { window.addEventListener('DOMContentLoaded', () => showToast(msg, ms)); return; }
    const el = document.createElement('div');
    el.className = 'wb-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
  }

  /* ---------- enable / disable ---------- */
  let isEnabled = ENABLED_DEFAULT;
  store.get(KEY_GLOBAL, ENABLED_DEFAULT).then(val => { isEnabled = !!val; log(`Script status loaded. Enabled: ${isEnabled}`); });
  GM.registerMenuCommand('Toggle auto-archiving', async () => { isEnabled = !isEnabled; await store.set(KEY_GLOBAL, isEnabled); alert(`Reddit → Wayback auto-archiver is now ${isEnabled ? 'ENABLED' : 'DISABLED'}.`); });

  /* ---------- Archive Queue System ---------- */
  let isQueueProcessing = false;

  async function addToArchiveQueue(url) {
    const queue = await store.get(KEY_QUEUE, []);
    if (!queue.some(item => item.url === url)) {
      queue.push({ url: url, addedAt: Date.now() });
      await store.set(KEY_QUEUE, queue);
      log('Added to archive queue:', url);
    }
  }

  // =================================================================
  // ========== FINAL, ROBUST QUEUE PROCESSING LOGIC =================
  // =================================================================
  async function processArchiveQueue() {
    if (isQueueProcessing) { log('Queue is already being processed. Skipping.'); return; }
    if (!isEnabled) return;

    // Get the item to process WITHOUT modifying the queue yet
    const initialQueue = await store.get(KEY_QUEUE, []);
    if (initialQueue.length === 0) return;
    const itemToProcess = initialQueue[0];

    isQueueProcessing = true;
    log('Acquired queue processing lock for item:', itemToProcess.url);

    try {
      const success = await submitToWayback(itemToProcess.url);

      // **CRITICAL FIX**: After the long task is done, get a FRESH copy of the queue.
      // This ensures we don't overwrite changes made by addToArchiveQueue while we were waiting.
      const currentQueue = await store.get(KEY_QUEUE, []);
      let finalQueue;

      if (success) {
        log('Archive successful. Removing item from queue.', itemToProcess.url);
        // Create the new queue by filtering out the successfully processed item.
        finalQueue = currentQueue.filter(item => item.url !== itemToProcess.url);
        await store.set('ts_' + itemToProcess.url, Date.now());
      } else {
        log('Archive failed. Rotating item to back of queue.', itemToProcess.url);
        // Create the new queue by filtering the item and re-adding it at the end.
        finalQueue = currentQueue.filter(item => item.url !== itemToProcess.url);
        finalQueue.push(itemToProcess);
      }
      
      // Now, save the correctly modified queue.
      await store.set(KEY_QUEUE, finalQueue);

    } catch (err) {
      console.error('[Wayback-archiver] Critical error during processing. Item will be rotated.', err);
      // Even on a critical error, we still rotate to prevent getting stuck.
      const currentQueue = await store.get(KEY_QUEUE, []);
      const finalQueue = currentQueue.filter(item => item.url !== itemToProcess.url);
      finalQueue.push(itemToProcess);
      await store.set(KEY_QUEUE, finalQueue);
    } finally {
      isQueueProcessing = false;
      log('Released queue processing lock.');
    }
  }

  /* ---------- main work ---------- */
  async function handlePage() {
    if (!isEnabled) return;
    const currentUrl = location.href;
    log('handlePage triggered for URL:', currentUrl);
    try {
      const canon = getCanonicalPostUrl(currentUrl);
      if (!canon) { log('Not a post page, skipping.', currentUrl); await store.set(KEY_LAST_URL, ''); return; }
      const lastCanonical = await store.get(KEY_LAST_URL, null);
      if (canon === lastCanonical) { log('Same post as last time, skipping.', canon); return; }
      const lastTimestamp = await store.get('ts_' + canon, 0);
      if (Date.now() - lastTimestamp < COOLDOWN_HOURS * HOUR) {
        log('Cool-down active, already saved recently →', canon);
        await store.set(KEY_LAST_URL, canon);
        return;
      }
      await store.set(KEY_LAST_URL, canon);
      log('New post detected:', canon);
      await addToArchiveQueue(canon);
      processArchiveQueue();
    } catch (err) {
      console.error('[Wayback-archiver] Error in handlePage:', err);
    }
  }

  /* ---------- Wayback submit ---------- */
  function submitToWayback(url) {
    const saveUrl = 'https://web.archive.org/save/' + encodeURIComponent(url);
    return new Promise(res => {
      GM.xmlHttpRequest({
        method: 'GET', url: saveUrl, timeout: 60000,
        onload: r => {
          const success = r.status >= 200 && r.status < 400;
          if (r.status >= 500) console.error(`Wayback server error (${r.status})`, url);
          log('Wayback response', r.status, url);
          showToast(success ? 'Successfully archived!' : 'Archive failed, will retry.');
          res(success);
        },
        onerror: e => { console.error('Wayback XHR error', e); showToast('Error connecting. Will retry.'); res(false); },
        ontimeout: () => { console.error('Wayback XHR timeout'); showToast('Request timed out. Will retry.'); res(false); }
      });
    });
  }

  /* ---------- canonicalisation ---------- */
  function getCanonicalPostUrl(href) {
    try {
      const url = new URL(href);
      if (url.hostname === 'redd.it') { const p = url.pathname.replace(/^\/|\/$/g, ''); return p ? `https://old.reddit.com/comments/${p}` : null; }
      const m = url.pathname.match(/\/(?:comments|gallery)\/([a-z0-9]+)/i);
      return (m && m[1]) ? `https://old.reddit.com/comments/${m[1]}` : null;
    } catch (e) { return null; }
  }

  /* ---------- ROBUST NAVIGATION HOOK VIA SCRIPT INJECTION ---------- */
  function injectNavigationListener() {
    const id = 'history-hook-script', ev = 'wayback_history_changed';
    if (document.getElementById(id)) return;
    const s = document.createElement('script'); s.id = id;
    s.textContent = `(()=>{const d=()=>window.dispatchEvent(new CustomEvent('${ev}')),h=history,p=h.pushState,r=h.replaceState;h.pushState=function(...a){p.apply(this,a);d()};h.replaceState=function(...a){r.apply(this,a);d()};window.addEventListener('popstate',d)})();`;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  function setupNavHooks() {
    injectNavigationListener();
    const debouncedHandlePage = (() => { let t; return () => { clearTimeout(t); t = setTimeout(handlePage, 500); }; })();
    window.addEventListener('wayback_history_changed', debouncedHandlePage);
    debouncedHandlePage();
    setInterval(processArchiveQueue, 60000);
  }

  log('Userscript injected.');
  setupNavHooks();
})();
