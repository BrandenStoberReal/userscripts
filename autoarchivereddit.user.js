// ==UserScript==
// @name         Reddit → Wayback auto-archiver (v2.5 Final)
// @namespace    reddit-wayback-autosave
// @version      2.5.0
// @description  A robust script to auto-submit Reddit posts and their content. Correctly handles SPA navigation, cooldowns, and interactive content.
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
  const KEY_LAST_CANONICAL = '_last_canonical_url'; // Restored for SPA navigation
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
    if (isQueueProcessing || !isEnabled) return;
    const tasksToProcess = await store.get(KEY_QUEUE, []);
    if (tasksToProcess.length === 0) return;
    isQueueProcessing = true;
    log(`Acquired lock. Processing a batch of ${tasksToProcess.length} items.`);
    const succeededUrls = [], failedUrls = [];
    try {
      for (const item of tasksToProcess) {
        if (!item || typeof item.url !== 'string') continue;
        const success = await submitToWayback(item.url);
        if (success) {
            await store.set('ts_' + item.url, Date.now());
            succeededUrls.push(item.url);
        } else {
            failedUrls.push(item.url);
        }
      }
    } catch (err) {
        console.error('[Wayback-archiver] A critical error occurred during batch processing.', err);
    } finally {
        if (succeededUrls.length > 0) {
            const latestQueue = await store.get(KEY_QUEUE, []);
            const finalQueue = latestQueue.filter(item => !(item && item.url && succeededUrls.includes(item.url)));
            await store.set(KEY_QUEUE, finalQueue);
        }
        isQueueProcessing = false;
        log('Released lock. Batch processing complete.');
        if (tasksToProcess.length > 0) {
            showToast(`Archive complete: ${succeededUrls.length} OK, ${failedUrls.length} failed.`, 5000);
        }
    }
  }

  function extractUrlsFromContainer(container) {
      const urls = new Set();
      const selectors = [
          'a[data-click-id="body"]', 'a.title',
          'div[data-test-id="post-content"] a', '.expando .md a',
          'div[data-media-container] a',
          'shreddit-player[src]',
          'iframe[src]'
      ].join(', ');
      container.querySelectorAll(selectors).forEach(el => {
          const url = el.getAttribute('src') || el.href;
          if (url && url.startsWith('http')) {
             try {
                 if (!/reddit\.com|redd\.it/.test(new URL(url).hostname)) {
                     urls.add(url);
                 }
             } catch(e) {/* Ignore invalid URLs */}
          }
      });
      return Array.from(urls);
  }

  function waitForElement(selector, context = document, timeout = 5000) {
      return new Promise((resolve) => {
          const el = context.querySelector(selector);
          if (el) return resolve(el);
          const observer = new MutationObserver(() => {
              const el = context.querySelector(selector);
              if (el) { observer.disconnect(); resolve(el); }
          });
          observer.observe(context, { childList: true, subtree: true });
          setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
      });
  }


  /* ---------- main work ---------- */
  async function handlePage(isRescan = false) {
    if (!isEnabled) return;
    try {
      const canon = getCanonicalPostUrl(location.href);

      // On a rescan, we only care about finding new content, not the page state.
      if (isRescan) {
          log('Rescanning page for new content...');
      } else {
          const lastCanon = await store.get(KEY_LAST_CANONICAL, null);
          // **FIX:** If it's the same page as before, do nothing. This is the crucial SPA fix.
          if (canon === lastCanon) return;
          
          await store.set(KEY_LAST_CANONICAL, canon); // Mark this page as "seen"

          if (!canon) return; // Not a post page, nothing more to do.

          const lastTimestamp = await store.get('ts_' + canon, 0);
          if (Date.now() - lastTimestamp < COOLDOWN_HOURS * HOUR) {
            log('Cool-down active for:', canon);
            return;
          }
          log('New post detected:', canon);
      }

      const postContainer = await waitForElement('div[data-testid="post-container"], div.thing');
      if (!postContainer) {
          log('Could not find post container.');
          return;
      }
      
      const allUrlsToArchive = new Set();
      // Only add the main post URL if it's the first scan of a new page.
      if (!isRescan && canon) {
          allUrlsToArchive.add(canon);
      }

      const contentUrls = extractUrlsFromContainer(postContainer);
      contentUrls.forEach(url => allUrlsToArchive.add(url));

      if (allUrlsToArchive.size > 0) {
          log(`Found ${allUrlsToArchive.size} total URLs to queue.`);
          for (const url of allUrlsToArchive) { await addToArchiveQueue(url); }
          processArchiveQueue();
      }

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
          if (!success) console.error(`Wayback server error (${r.status}) for`, url);
          res(success);
        },
        onerror: e => { console.error('Wayback XHR error', e); res(false); },
        ontimeout: () => { console.error('Wayback XHR timeout'); res(false); }
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
    s.textContent = `(()=>{if(window.top!==window.self)return;const d=()=>{try{window.dispatchEvent(new CustomEvent('${ev}'))}catch(e){}},h=history,p=h.pushState,r=h.replaceState;h.pushState=function(...a){p.apply(this,a);d()};h.replaceState=function(...a){r.apply(this,a);d()};window.addEventListener('popstate',d)})();`;
    (document.head || document.documentElement).appendChild(s);
  }

  function setupInteractionListener() {
    document.body.addEventListener('click', (event) => {
        const revealButton = event.target.closest('.nsfw-see-more button, div[data-testid="post-content"] button');
        if (revealButton) {
            log('Sensitive content reveal clicked. Triggering a rescan in 2 seconds.');
            setTimeout(() => handlePage(true), 2000);
        }
    }, true);
  }

  function setupNavHooks() {
    injectNavigationListener();
    setupInteractionListener();
    const debouncedHandlePage = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => handlePage(false), 500); }; })();
    window.addEventListener('wayback_history_changed', debouncedHandlePage);
    debouncedHandlePage();
    setInterval(processArchiveQueue, 60000);
  }

  log('Userscript injected.');
  setupNavHooks();
})();
