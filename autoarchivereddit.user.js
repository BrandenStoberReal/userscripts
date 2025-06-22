// ==UserScript==
// @name         Reddit → Wayback auto-archiver
// @namespace    reddit-wayback-autosave
// @version      1.0.7
// @description  When you open a Reddit post, automatically submit it to the Wayback Machine once every N hours.
// @author       Branden Stober + GPT-o3
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
  /* =========  USER OPTIONS  ========= */
  const COOLDOWN_HOURS   = 24;   // How long to wait before re-submitting the SAME post
  const ENABLED_DEFAULT  = true; // Set to false if you want it shipped disabled
  /* ================================== */

  /* ----------  STYLE / TOAST  ---------- */
  GM_addStyle(`
    .wb-toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      max-width: 260px;
      padding: 8px 12px;
      font: 13px/17px system-ui, sans-serif;
      color: #fff;
      background: #323232e6;
      border-radius: 4px;
      box-shadow: 0 2px 4px rgba(0,0,0,.35);
      opacity: 0;
      transform: translateY(10px);
      transition: opacity .25s ease-out, transform .25s ease-out;
      z-index: 2147483647;
      pointer-events: none;
    }
    .wb-toast.show {
      opacity: 1;
      transform: translateY(0);
    }
  `);

  function showToast(msg, ms = 3500) {
    const toast = document.createElement('div');
    toast.className = 'wb-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, ms);
  }

  /* ----------  STATE HELPERS ---------- */
  const KEY_ENABLED = '_enabled';
  const HOURS       = 1000 * 60 * 60;

  const store = {
    async get(k, d) { return GM.getValue(k, d); },
    async set(k, v) { return GM.setValue(k, v); }
  };

  async function isEnabled() {
    return !!(await store.get(KEY_ENABLED, ENABLED_DEFAULT));
  }
  async function toggleEnabled() {
    const cur = await isEnabled();
    await store.set(KEY_ENABLED, !cur);
    alert(`Reddit → Wayback auto-archiver is now ${!cur ? 'ENABLED' : 'DISABLED'}.`);
  }
  GM.registerMenuCommand('Toggle auto-archiving', toggleEnabled);

  /* ----------  MAIN WORK ---------- */
  let lastProcessedCanonical = null;

  async function processCurrentPage() {
    if (!await isEnabled()) return;

    const postUrl = getCanonicalPostUrl();
    if (!postUrl) return;               // not a post
    if (postUrl === lastProcessedCanonical) return; // already done for this URL
    lastProcessedCanonical = postUrl;

    const postKey  = 'ts_' + postUrl;
    const lastSave = await store.get(postKey, 0);
    if (Date.now() - lastSave < COOLDOWN_HOURS * HOURS) return;

    const { ok, status } = await submitToWayback(postUrl);
    if (ok) {
      await store.set(postKey, Date.now());
      showToast(
        (status === 200 || status === 302)
          ? 'Wayback snapshot stored ✓'
          : 'Wayback snapshot queued (will appear soon) ⏳'
      );
    } else {
      showToast('Wayback snapshot failed ✗', 4500);
    }
  }

  /* ----------  SPA NAVIGATION HOOK ---------- */
  // Dispatch a custom 'locationchange' event whenever history changes
  (function() {
    const push = history.pushState;
    const rep  = history.replaceState;

    history.pushState = function () {
      push.apply(this, arguments);
      window.dispatchEvent(new Event('locationchange'));
    };
    history.replaceState = function () {
      rep.apply(this, arguments);
      window.dispatchEvent(new Event('locationchange'));
    };
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));
  })();

  // React to the custom event
  window.addEventListener('locationchange', () => {
    // Give Reddit a tick to render the new page before we act
    setTimeout(processCurrentPage, 0);
  });

  // Also run once when the userscript initially loads
  processCurrentPage();

  /* ----------  HELPERS ---------- */
  function getCanonicalPostUrl() {
    try {
      const url = new URL(location.href);

      if (url.hostname === 'redd.it') {
        return url.href.replace(/\/$/, '');
      }

      if (/^\/r\/[^/]+\/comments\/[A-Za-z0-9]+/.test(url.pathname)) {
        return url.origin + url.pathname.replace(/\/$/, '');
      }
    } catch { /* ignore */ }
    return null;
  }

  function submitToWayback(pageUrl) {
    return new Promise(resolve => {
      GM.xmlHttpRequest({
        method : 'GET',
        url    : 'https://web.archive.org/save/' + encodeURIComponent(pageUrl),
        onload : r => resolve({ ok: r.status >= 200 && r.status < 400, status: r.status }),
        onerror: () => resolve({ ok: false, status: 0 })
      });
    });
  }
})();
