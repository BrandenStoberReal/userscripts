// ==UserScript==
// @name         Reddit → Wayback auto-archiver
// @namespace    reddit-wayback-autosave
// @version      1.4.2
// @description  Auto-submit every Reddit post you visit to the Wayback Machine (works with SPA navigation).
// @author       Branden Stober
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
  const log = (...a) => console.log('[Wayback-archiver]', ...a);

  /* ---------- little toast ---------- */
  GM.addStyle(`
   .wb-toast{position:fixed;bottom:20px;right:20px;max-width:260px;padding:8px 12px;
    font:13px/17px system-ui,sans-serif;color:#fff;background:#323232e6;border-radius:4px;
    box-shadow:0 2px 4px rgba(0,0,0,.35);opacity:0;transform:translateY(10px);
    transition:opacity .25s,transform .25s;z-index:2147483647;pointer-events:none}
   .wb-toast.show{opacity:1;transform:translateY(0)}
  `);
  
  function showToast(msg, ms = 3500) {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', () => showToast(msg, ms));
      return;
    }
    const el = document.createElement('div');
    el.className = 'wb-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  /* ---------- enable / disable ---------- */
  let isEnabled = ENABLED_DEFAULT;
  store.get(KEY_GLOBAL, ENABLED_DEFAULT).then(val => {
    isEnabled = !!val;
    processArchiveQueue();
  });

  GM.registerMenuCommand('Toggle auto-archiving', async () => {
    isEnabled = !isEnabled;
    await store.set(KEY_GLOBAL, isEnabled);
    alert(`Reddit → Wayback auto-archiver is now ${isEnabled ? 'ENABLED' : 'DISABLED'}.`);
  });

  /* ---------- Archive Queue System ---------- */
  async function addToArchiveQueue(url) {
    const queue = await store.get(KEY_QUEUE, []);
    if (!queue.some(item => item.url === url)) {
      queue.push({ url: url, addedAt: Date.now() });
      await store.set(KEY_QUEUE, queue);
      log('Added to archive queue:', url);
    }
  }

  async function removeFromArchiveQueue(url) {
    const queue = await store.get(KEY_QUEUE, []);
    const newQueue = queue.filter(item => item.url !== url);
    if (queue.length !== newQueue.length) {
      await store.set(KEY_QUEUE, newQueue);
      log('Removed from archive queue:', url);
    }
  }

  async function processArchiveQueue() {
    if (!isEnabled) return;
    const queue = await store.get(KEY_QUEUE, []);
    if (queue.length === 0) return;
    log(`Processing archive queue (${queue.length} items)...`);
    const item = queue[0];
    try {
      const success = await submitToWayback(item.url);
      if (success) {
        const key = 'ts_' + item.url;
        await store.set(key, Date.now());
        log('Successfully archived and set cooldown for:', item.url);
      } else {
        log('Failed to archive, will retry later:', item.url);
      }
    } catch (err) {
      console.error('[Wayback-archiver] Error processing queue item:', err);
    }
    await removeFromArchiveQueue(item.url);
    if (queue.length > 1) {
      setTimeout(processArchiveQueue, 20000);
    }
  }

  /* ---------- main work ---------- */
  let processingPage = false;

  async function handlePage() {
    if (processingPage) return;
    processingPage = true;
    try {
      if (!isEnabled) return;
      const canon = getCanonicalPostUrl(location.href);
      if (!canon) {
        log('Not a post page, skipping:', location.href);
        processingPage = false;
        return;
      }
      
      const lastCanonical = await store.get(KEY_LAST_URL, null);
      if (canon === lastCanonical) {
        log('Same post as last time, skipping:', canon);
        processingPage = false;
        return;
      }
      
      await store.set(KEY_LAST_URL, canon);
      log('New post detected:', canon);

      const key = 'ts_' + canon;
      const last = await store.get(key, 0);
      if (Date.now() - last < COOLDOWN_HOURS * HOUR) {
        log('cool-down, already saved recently →', canon);
        processingPage = false;
        return;
      }
      showToast('Submitting to Wayback Machine...');
      await addToArchiveQueue(canon);
      processArchiveQueue();
    } catch (err) {
      console.error('[Wayback-archiver] Error:', err);
    } finally {
      processingPage = false;
    }
  }

  /* ---------- Wayback submit ---------- */
  function submitToWayback(url) {
    const saveUrl = 'https://web.archive.org/save/' + encodeURIComponent(url);
    return new Promise(res => {
      GM.xmlHttpRequest({
        method : 'GET',
        url    : saveUrl,
        timeout: 60000,
        onload : r => {
          if (r.status === 520) {
            console.error('Wayback response 520: Server error. Likely rate-limited.', url);
            showToast('Wayback Machine is busy. Will retry later.');
            res(false);
            return;
          }
          const success = r.status >= 200 && r.status < 400;
          log('Wayback response', r.status, url);
          if (success) {
            showToast('Successfully archived to Wayback Machine!');
          } else {
            showToast('Failed to archive. Will retry later.');
          }
          res(success);
        },
        onerror: e => {
          console.error('Wayback XHR error', e);
          showToast('Error connecting to Wayback Machine. Will retry later.');
          res(false);
        },
        ontimeout: () => {
          console.error('Wayback XHR timeout');
          showToast('Wayback Machine request timed out. Will retry later.');
          res(false);
        }
      });
    });
  }

  /* ---------- canonicalisation ---------- */
  function getCanonicalPostUrl(href) {
    try {
      let url = new URL(href);
      if (url.hostname === 'redd.it') {
        return `https://old.reddit.com/comments/${url.pathname.replace(/^\/|\/$/g, '')}`;
      }
      const match = url.pathname.match(/^\/r\/([^/]+)\/comments\/([A-Za-z0-9]+)(\/|$)/);
      if (match) {
        const [, sub, postId] = match;
        return `https://old.reddit.com/r/${sub}/comments/${postId}`;
      }
    } catch {
      return null;
    }
    return null;
  }

  /* ---------- SPA navigation hook ---------- */
  function setupNavHooks() {
    const debouncedHandlePage = (() => {
        let timer;
        return () => {
            clearTimeout(timer);
            timer = setTimeout(handlePage, 250);
        };
    })();

    const origPushState = history.pushState;
    history.pushState = function(...args) {
        origPushState.apply(this, args);
        debouncedHandlePage();
    };
    
    const origReplaceState = history.replaceState;
    history.replaceState = function(...args) {
        origReplaceState.apply(this, args);
        debouncedHandlePage();
    };

    window.addEventListener('popstate', debouncedHandlePage);

    // *** CHANGE: Initial page load now uses the debouncer. ***
    // This prevents the race condition where handlePage runs twice,
    // once immediately and once from a history event, causing it to
    // incorrectly flag the page as a duplicate of itself.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', debouncedHandlePage);
    } else {
      debouncedHandlePage();
    }
    
    setInterval(processArchiveQueue, 60000);
  }
  
  setupNavHooks();
})();
