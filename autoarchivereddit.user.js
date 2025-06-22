// ==UserScript==
// @name         Reddit → Wayback auto-archiver
// @namespace    reddit-wayback-autosave
// @version      1.0.8
// @description  Auto-submit every Reddit post you visit to the Wayback Machine (works with SPA navigation).
// @author       Branden Stober
// @updateURL    https://raw.githubusercontent.com/BrandenStoberReal/userscripts/main/autoarchivereddit.user.js
// @downloadURL  https://raw.githubusercontent.com/BrandenStoberReal/userscripts/main/autoarchivereddit.user.js
// @match        https://www.reddit.com/r/*/comments/*
// @match        https://old.reddit.com/r/*/comments/*
// @match        https://np.reddit.com/r/*/comments/*
// @match        https://redd.it/*
// @icon         https://www.redditstatic.com/desktop2x/img/favicon/apple-icon-57x57.png
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @grant        GM_addStyle
// @connect      web.archive.org
// @run-at       document-end
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
    get: (k, d) => GM.getValue(k, d),
    set: (k, v) => GM.setValue(k, v)
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
    const el = document.createElement('div');
    el.className = 'wb-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
    }, ms);
  }

  /* ---------- enable / disable ---------- */
  GM.registerMenuCommand('Toggle auto-archiving', async () => {
    const cur = !!(await store.get(KEY_GLOBAL, ENABLED_DEFAULT));
    await store.set(KEY_GLOBAL, !cur);
    alert(`Reddit → Wayback auto-archiver is now ${!cur ? 'ENABLED' : 'DISABLED'}.`);
  });

  async function enabled() {
    return !!(await store.get(KEY_GLOBAL, ENABLED_DEFAULT));
  }

  /* ---------- main work ---------- */
  let lastCanonical = null;

  async function handlePage() {
    if (!await enabled()) return;

    const canon = canonicalise(location.href);
    if (!canon) return;               // not a post
    if (canon === lastCanonical) return;
    lastCanonical = canon;

    const key = 'ts_' + canon;
    const last = await store.get(key, 0);
    if (Date.now() - last < COOLDOWN_HOURS * HOUR) {
      log('cool-down, already saved recently →', canon);
      return;
    }

    const { ok, status } = await saveToWayback(canon);
    if (ok) {
      await store.set(key, Date.now());
      toast((status === 200 || status === 302) ?
            'Wayback snapshot stored ✓' :
            'Wayback snapshot queued ⏳');
    } else {
      toast('Wayback snapshot FAILED ✗', 4500);
    }
  }

  /* ---------- Wayback submit ---------- */
  function saveToWayback(url) {
    const saveUrl = 'https://web.archive.org/save/' + encodeURIComponent(url);
    return new Promise(res => {
      GM.xmlHttpRequest({
        method : 'GET',
        url    : saveUrl,
        headers: { 'User-Agent': navigator.userAgent },   // some proxies strip UA; be explicit
        onload : r => {
          const ok = r.status >= 200 && r.status < 400;
          log('Wayback response', r.status, url);
          res({ ok, status: r.status });
        },
        onerror: e => {
          console.error('Wayback XHR error', e);
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
  // 1. intercept push/replaceState
  (function() {
    const push = history.pushState, repl = history.replaceState;
    history.pushState    = function() { push.apply(this, arguments);  fire(); };
    history.replaceState = function() { repl.apply(this, arguments);  fire(); };
    window.addEventListener('popstate', fire);
    // some mobile builds use a MutationObserver instead of history, fall back as well:
    const obs = new MutationObserver(fire);
    obs.observe(document.querySelector('title'), { childList: true });
    function fire() { setTimeout(handlePage, 0); }
  })();

  // run once on initial load
  handlePage();
})();
