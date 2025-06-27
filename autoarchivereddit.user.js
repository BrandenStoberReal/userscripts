// ==UserScript==
// @name         Reddit → Wayback auto-archiver (Improved v2.1)
// @namespace    reddit-wayback-autosave
// @version      2.1.1
// @description  A robust script to auto-submit Reddit posts and their content to the Wayback Machine. Fixes cross-origin errors.
// @author       Branden Stober (fixed by AI, improved by AI)
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
    if (!queue.some(item => item && item.url === url)) {
      queue.push({ url: url, addedAt: Date.now() });
      await store.set(KEY_QUEUE, queue);
      log('Added to archive queue:', url);
      showToast('Added to archive queue.');
    }
  }

  async function processArchiveQueue() {
    if (isQueueProcessing) { return; }
    if (!isEnabled) return;
    const tasksToProcess = await store.get(KEY_QUEUE, []);
    if (tasksToProcess.length === 0) return;
    isQueueProcessing = true;
    log(`Acquired lock. Processing a batch of ${tasksToProcess.length} items.`);
    const succeededUrls = [], failedUrls = [];
    try {
      for (const [i, item] of tasksToProcess.entries()) {
        const logPrefix = `[${i + 1}/${tasksToProcess.length}]`;
        if (!item || typeof item.url !== 'string') {
            console.error('[Wayback-archiver]', logPrefix, 'Found and will remove a corrupted item.', item);
            if (item && item.url) succeededUrls.push(item.url);
            continue;
        }
        log(logPrefix, 'Attempting to archive:', item.url);
        const success = await submitToWayback(item.url);
        if (success) {
            log(logPrefix, 'Archive successful for:', item.url);
            await store.set('ts_' + item.url, Date.now());
            succeededUrls.push(item.url);
        } else {
            log(logPrefix, 'Archive failed, item will remain in queue for next run.', item.url);
            failedUrls.push(item.url);
        }
      }
    } catch (err) {
        console.error('[Wayback-archiver] A critical error occurred during batch processing.', err);
    } finally {
        if (succeededUrls.length > 0) {
            const latestQueue = await store.get(KEY_QUEUE, []);
            const finalQueue = latestQueue.filter(item => !item || typeof item.url !== 'string' ? false : !succeededUrls.includes(item.url));
            await store.set(KEY_QUEUE, finalQueue);
        }
        isQueueProcessing = false;
        log('Released lock. Batch processing complete.');
        if (tasksToProcess.length > 0) {
            let summaryMsg = `Archive batch complete: ${succeededUrls.length} successful.`;
            if (failedUrls.length > 0) summaryMsg += ` ${failedUrls.length} failed (will retry).`;
            showToast(summaryMsg, 5000);
        }
    }
  }

  function extractUrlsFromPage() {
      const urls = new Set();
      const selectors = [
          'a[data-click-id="body"]',
          'img[alt="Post image"]',
          'div[data-test-id="post-content"] a',
          'a.title',
          '.media-preview a',
          '.expando .md a',
      ].join(', ');

      document.querySelectorAll(selectors).forEach(el => {
          try {
            const url = el.tagName === 'IMG' ? el.src : el.href;
            if (url && url.startsWith('http') && !/reddit\.com|redd\.it/.test(new URL(url).hostname)) {
                urls.add(url);
            }
          } catch (e) { /* Ignore invalid URLs */ }
      });
      return Array.from(urls);
  }

  function pollForContentUrls(timeout = 10000, interval = 500) {
    return new Promise(resolve => {
        let attempts = 0;
        const maxAttempts = timeout / interval;
        const poller = setInterval(() => {
            const urls = extractUrlsFromPage();
            if (urls.length > 0) {
                log(`Found content URLs after ${attempts * interval}ms.`);
                clearInterval(poller);
                resolve(urls);
            } else if (attempts >= maxAttempts) {
                log('Polling timed out. No unique content URLs found.');
                clearInterval(poller);
                resolve([]);
            }
            attempts++;
        }, interval);
    });
  }

  /* ---------- main work ---------- */
  async function handlePage() {
    if (!isEnabled) return;
    try {
      const canon = getCanonicalPostUrl(location.href);
      if (!canon) { await store.set(KEY_LAST_URL, ''); return; }
      const lastCanonical = await store.get(KEY_LAST_URL, null);
      if (canon === lastCanonical) return;
      const lastTimestamp = await store.get('ts_' + canon, 0);
      if (Date.now() - lastTimestamp < COOLDOWN_HOURS * HOUR) {
        log('Cool-down active for:', canon);
        await store.set(KEY_LAST_URL, canon);
        return;
      }
      await store.set(KEY_LAST_URL, canon);
      log('New post detected:', canon);
      const allUrlsToArchive = new Set([canon]);
      const contentUrls = await pollForContentUrls();
      contentUrls.forEach(url => allUrlsToArchive.add(url));
      log(`Total URLs to queue: ${allUrlsToArchive.size}`, Array.from(allUrlsToArchive));
      for (const url of allUrlsToArchive) {
          await addToArchiveQueue(url);
      }
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
          try {
            showToast(success ? `Archived: ${new URL(url).hostname}` : 'Archive failed, will retry.');
          } catch (e) {
            showToast(success ? 'Successfully archived!' : 'Archive failed, will retry.');
          }
          res(success);
        },
        onerror: e => { console.error('Wayback XHR error', e); showToast('Error connecting. Will retry.'); res(false); },
        ontimeout: () => { console.error('Wayback XHR timeout'); showToast('Request timed out. Will retry.'); res(false); }
      });
    });
  }

  /* ---------- URL & Nav Helpers ---------- */
  function getCanonicalPostUrl(href) {
    try {
      const url = new URL(href);
      if (url.hostname === 'redd.it') {
        const p = url.pathname.replace(/^\/|\/$/g, '');
        return p ? `https://old.reddit.com/comments/${p}` : null;
      }
      const m = url.pathname.match(/\/(?:comments|gallery)\/([a-z0-9]+)/i);
      return (m && m[1]) ? `https://old.reddit.com/comments/${m[1]}` : null;
    } catch (e) { return null; }
  }

  function injectNavigationListener() {
    const id = 'history-hook-script', ev = 'wayback_history_changed';
    if (document.getElementById(id)) return;
    const s = document.createElement('script'); s.id = id;
    // **THE FIX IS HERE**: The injected script now checks if it's in the top window.
    // If not (i.e., it's in an iframe), it does nothing.
    s.textContent = `(()=>{if(window.top!==window.self)return;const d=()=>window.dispatchEvent(new CustomEvent('${ev}')),h=history,p=h.pushState,r=h.replaceState;h.pushState=function(...a){p.apply(this,a);d()};h.replaceState=function(...a){r.apply(this,a);d()};window.addEventListener('popstate',d)})();`;
    (document.head || document.documentElement).appendChild(s);
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
