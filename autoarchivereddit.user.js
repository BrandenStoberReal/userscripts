// ==UserScript==
// @name         Reddit → Wayback auto-archiver
// @namespace    reddit-wayback-autosave
// @version      1.0.10
// @description  Auto-submit every Reddit post you visit to the Wayback Machine (works with SPA navigation).
// @author       Branden Stober
// @updateURL    https://raw.githubusercontent.com/BrandenStoberReal/userscripts/main/autoarchivereddit.user.js
// @downloadURL  https://raw.githubusercontent.com/BrandenStoberReal/userscripts/main/autoarchivereddit.user.js
// @match        https://www.reddit.com/r/*/comments/*
// @match        https://old.reddit.com/r/*/comments/*
// @match        https://np.reddit.com/r/*/comments/*
// @match        https://redd.it/*
// @icon         https://www.redditstatic.com/desktop2x/img/favicon/apple-icon-57x57.png
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlHttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      web.archive.org
// @run-at       document-start
// ==/UserScript==

(() => {
  /* ========== USER SETTINGS ========== */
  const COOLDOWN_HOURS  = 24;   // do not resubmit same post within N hours
  const ENABLED_DEFAULT = true; // shipped state
  /* =================================== */

  /* ---------- tiny helpers ---------- */
  const HOUR       = 36e5;
  const KEY_GLOBAL = '_enabled';
  const store = {
    get: (k, d) => GM_getValue(k, d),
    set: (k, v) => GM_setValue(k, v)
  };
  const log = (...a) => console.log('[Wayback-archiver]', ...a);

  /* ---------- little toast ---------- */
  GM_addStyle(`
   .wb-toast{position:fixed;bottom:20px;right:20px;max-width:260px;padding:8px 12px;
    font:13px/17px system-ui,sans-serif;color:#fff;background:#323232e6;border-radius:4px;
    box-shadow:0 2px 4px rgba(0,0,0,.35);opacity:0;transform:translateY(10px);
    transition:opacity .25s,transform .25s;z-index:2147483647;pointer-events:none}
   .wb-toast.show{opacity:1;transform:translateY(0)}
  `);
  
  function toast(msg, ms = 3500) {
    // Don't try to show toast if document.body isn't ready yet
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', () => toast(msg, ms));
      return;
    }
    
    const el = document.createElement('div');
    el.className = 'wb-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    
    // Use setTimeout instead of requestAnimationFrame for better browser compatibility
    setTimeout(() => el.classList.add('show'), 10);
    
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  /* ---------- enable / disable ---------- */
  // Cache the enabled state to avoid waiting for GM_getValue on every check
  let isEnabled = ENABLED_DEFAULT;
  
  // Initialize the cached value as soon as possible
  store.get(KEY_GLOBAL, ENABLED_DEFAULT).then(val => {
    isEnabled = !!val;
  });

  GM_registerMenuCommand('Toggle auto-archiving', async () => {
    isEnabled = !isEnabled;
    await store.set(KEY_GLOBAL, isEnabled);
    alert(`Reddit → Wayback auto-archiver is now ${isEnabled ? 'ENABLED' : 'DISABLED'}.`);
  });

  /* ---------- main work ---------- */
  let lastCanonical = null;
  let processingPage = false; // Prevent multiple simultaneous runs

  async function handlePage() {
    if (processingPage) return;
    processingPage = true;
    
    try {
      if (!isEnabled) {
        processingPage = false;
        return;
      }

      const canon = canonicalise(location.href);
      if (!canon) {
        processingPage = false;
        return;               // not a post
      }
      
      if (canon === lastCanonical) {
        processingPage = false;
        return;
      }
      lastCanonical = canon;

      const key = 'ts_' + canon;
      const last = await store.get(key, 0);
      if (Date.now() - last < COOLDOWN_HOURS * HOUR) {
        log('cool-down, already saved recently →', canon);
        processingPage = false;
        return;
      }

      // Don't wait for the Wayback save to complete before continuing
      saveToWayback(canon).then(({ ok, status }) => {
        if (ok) {
          store.set(key, Date.now());
          toast((status === 200 || status === 302) ?
                'Wayback snapshot stored ✓' :
                'Wayback snapshot queued ⏳');
        } else {
          toast('Wayback snapshot FAILED ✗', 4500);
        }
      });
      
      // Allow the script to continue immediately
      processingPage = false;
    } catch (err) {
      console.error('[Wayback-archiver] Error:', err);
      processingPage = false;
    }
  }

  /* ---------- Wayback submit ---------- */
  function saveToWayback(url) {
    const saveUrl = 'https://web.archive.org/save/' + encodeURIComponent(url);
    return new Promise(res => {
      GM_xmlHttpRequest({
        method : 'GET',
        url    : saveUrl,
        headers: { 'User-Agent': navigator.userAgent },
        timeout: 15000, // 15 second timeout instead of waiting forever
        onload : r => {
          const ok = r.status >= 200 && r.status < 400;
          log('Wayback response', r.status, url);
          res({ ok, status: r.status });
        },
        onerror: e => {
          console.error('Wayback XHR error', e);
          res({ ok: false, status: 0 });
        },
        ontimeout: () => {
          console.error('Wayback XHR timeout');
          res({ ok: false, status: 0 });
        }
      });
    });
  }

  /* ---------- canonicalisation ---------- */
  function canonicalise(href) {
    let url;
    try { url = new URL(href); }
    catch { return null; }

    // redd.it short links
    if (url.hostname === 'redd.it') {
      return `https://old.reddit.com/comments/${url.pathname.replace(/^\/|\/$/g, '')}`;
    }

    // Any /r/.../comments/<id>/ path – normalise to old.reddit
    const match = url.pathname.match(/^\/r\/([^/]+)\/comments\/([A-Za-z0-9]+)(\/|$)/);
    if (match) {
      const [, sub, postId] = match;
      return `https://old.reddit.com/r/${sub}/comments/${postId}`;
    }
    return null;
  }

  /* ---------- SPA navigation hook ---------- */
  function setupNavHooks() {
    // 1. Intercept push/replaceState immediately
    const push = history.pushState, repl = history.replaceState;
    history.pushState = function() { 
      push.apply(this, arguments);
      setTimeout(handlePage, 10); // Minimal delay
    };
    history.replaceState = function() { 
      repl.apply(this, arguments);
      setTimeout(handlePage, 10);
    };
    
    // 2. Listen for popstate events
    window.addEventListener('popstate', () => setTimeout(handlePage, 10));
    
    // 3. Set up a MutationObserver as a fallback for Reddit's SPA
    // This helps detect when content has changed even if history methods weren't used
    const observer = new MutationObserver((mutations) => {
      // Only trigger if URL contains "/comments/" to avoid excessive processing
      if (location.href.includes('/comments/')) {
        setTimeout(handlePage, 10);
      }
    });
    
    // Start observing once the body exists
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      window.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
    
    // 4. Run once on load - don't wait for DOMContentLoaded
    handlePage();
    
    // 5. Also run on DOMContentLoaded as a fallback
    window.addEventListener('DOMContentLoaded', handlePage);
  }
  
  // Set up all navigation hooks immediately
  setupNavHooks();
})();
