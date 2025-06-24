// ==UserScript==
// @name         Reddit → Wayback auto-archiver
// @namespace    reddit-wayback-autosave
// @version      1.6.1
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
    log(`Script status loaded. Enabled: ${isEnabled}`);
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
    } else {
      log('URL is already in the queue, not adding again:', url);
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

  // =================================================================
  // ========== FIXED FUNCTION =======================================
  // =================================================================
  /**
   * This function has been rewritten to be more robust. It now only
   * removes an item from the queue after a SUCCESSFUL archive.
   * If an archive fails, the item remains in the queue to be retried later.
   */
  async function processArchiveQueue() {
    if (!isEnabled) return;
    const queue = await store.get(KEY_QUEUE, []);
    if (queue.length === 0) return;

    log(`Processing archive queue (${queue.length} items)...`);
    const item = queue[0];

    try {
      const success = await submitToWayback(item.url);

      if (success) {
        log('Archive successful for:', item.url);
        // 1. Set the long-term cooldown timestamp. THIS IS THE KEY FIX.
        await store.set('ts_' + item.url, Date.now());
        log('Set 24-hour cooldown for:', item.url);

        // 2. Remove the item from the queue now that it's done.
        await removeFromArchiveQueue(item.url);

      } else {
        log('Archive failed, will retry later:', item.url);
        // On failure, we DO NOT remove the item from the queue.
        // It will be retried automatically by the setInterval.
      }
    } catch (err) {
      console.error('[Wayback-archiver] Error processing queue item:', err);
      // Also do nothing, let it be retried.
    }
  }


  /* ---------- main work ---------- */
  async function handlePage() {
    if (!isEnabled) {
      log('Handler called, but script is disabled. Aborting.');
      return;
    }

    const currentUrl = location.href;
    log('handlePage triggered for URL:', currentUrl);

    try {
      const canon = getCanonicalPostUrl(currentUrl);
      if (!canon) {
        log('Not a post page, skipping:', currentUrl);
        await store.set(KEY_LAST_URL, '');
        return;
      }

      const lastCanonical = await store.get(KEY_LAST_URL, null);
      if (canon === lastCanonical) {
        log('Same post as last time, skipping:', canon);
        return;
      }

      // Check for the 24-hour cooldown BEFORE adding to the queue.
      const lastTimestamp = await store.get('ts_' + canon, 0);
      if (Date.now() - lastTimestamp < COOLDOWN_HOURS * HOUR) {
        log('Cool-down active, already saved recently →', canon);
        // Also update KEY_LAST_URL here to prevent re-triggering on minor URL changes
        await store.set(KEY_LAST_URL, canon);
        return;
      }

      await store.set(KEY_LAST_URL, canon);
      log('New post detected:', canon);

      await addToArchiveQueue(canon);
      processArchiveQueue(); // Start processing immediately

    } catch (err) {
      console.error('[Wayback-archiver] Error in handlePage:', err);
    }
  }

  /* ---------- Wayback submit ---------- */
  function submitToWayback(url) {
    const saveUrl = 'https://web.archive.org/save/' + encodeURIComponent(url);
    return new Promise(res => {
      GM.xmlHttpRequest({
        method: 'GET',
        url: saveUrl,
        timeout: 60000,
        onload: r => {
          const success = r.status >= 200 && r.status < 400;
          if (r.status === 520) console.error('Wayback response 520: Server error. Likely rate-limited.', url);
          log('Wayback response', r.status, url);
          showToast(success ? 'Successfully archived to Wayback Machine!' : 'Failed to archive. Will retry later.');
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
      const url = new URL(href);
      if (url.hostname === 'redd.it') {
        const postId = url.pathname.replace(/^\/|\/$/g, '');
        return postId ? `https://old.reddit.com/comments/${postId}` : null;
      }
      const match = url.pathname.match(/\/(?:comments|gallery)\/([a-z0-9]+)/i);
      return (match && match[1]) ? `https://old.reddit.com/comments/${match[1]}` : null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- ROBUST NAVIGATION HOOK VIA SCRIPT INJECTION ---------- */
  function injectNavigationListener() {
    const SCRIPT_ID = 'history-hook-script';
    const EVENT_NAME = 'wayback_history_changed';
    if (document.getElementById(SCRIPT_ID)) return;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.textContent = `(() => {
        const dispatch = () => window.dispatchEvent(new CustomEvent('${EVENT_NAME}'));
        const oPush = history.pushState, oRepl = history.replaceState;
        history.pushState = function(...a) { oPush.apply(this, a); dispatch(); };
        history.replaceState = function(...a) { oRepl.apply(this, a); dispatch(); };
        window.addEventListener('popstate', dispatch);
      })();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    log('Navigation listener injected into page context.');
  }

  function setupNavHooks() {
    injectNavigationListener();
    const debouncedHandlePage = (() => {
        let timer;
        return () => { clearTimeout(timer); timer = setTimeout(handlePage, 500); };
    })();
    window.addEventListener('wayback_history_changed', debouncedHandlePage);
    debouncedHandlePage();
    setInterval(processArchiveQueue, 60000); // Periodically retry failed items
  }

  log('Userscript injected.');
  setupNavHooks();
})();
