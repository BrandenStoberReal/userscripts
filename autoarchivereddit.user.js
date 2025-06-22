// ==UserScript==
// @name         Reddit → Wayback auto-archiver
// @namespace    reddit-wayback-autosave
// @version      1.0.2
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
// @run-at       document-idle
// ==/UserScript==

(() => {
    /* =========  USER OPTIONS  ========= */
    const COOLDOWN_HOURS = 24;         // How long to wait before re-submitting the SAME post
    const ENABLED_DEFAULT = true;      // Set to false if you want it shipped disabled
    /* ================================== */

    /* -------  STYLE / TOAST  ------- */
    GM_addStyle(`
      .wb-toast {
        position: fixed;
        bottom: 20px;
        right: 20px;
        max-width: 260px;
        padding: 8px 12px;
        font: 13px/17px system-ui, sans-serif;
        color: #fff;
        background: #323232e6;     /* translucent dark */
        border-radius: 4px;
        box-shadow: 0 2px 4px rgba(0,0,0,.35);
        opacity: 0;
        transform: translateY(10px);
        transition: opacity .25s ease-out, transform .25s ease-out;
        z-index: 2147483647;
        pointer-events: none;      /* don’t block clicks */
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

        // trigger CSS transition
        requestAnimationFrame(() => toast.classList.add('show'));

        // remove after N ms
        setTimeout(() => {
            toast.classList.remove('show');
            toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        }, ms);
    }
    
    /* -------  state helpers  ------- */
    const KEY_ENABLED = '_enabled';                // global on/off switch
    const now = () => Date.now();
    const hours = 1000 * 60 * 60;

    /* Promisified GM storage */
    const store = {
        async get(key, def = undefined) { return (await GM.getValue(key, def)); },
        async set(key, value) { return GM.setValue(key, value); }
    };

    /* -------  enable / disable  ------- */
    async function isEnabled() {
        const v = await store.get(KEY_ENABLED, ENABLED_DEFAULT);
        return !!v;
    }
    async function toggleEnabled() {
        const current = await isEnabled();
        await store.set(KEY_ENABLED, !current);
        alert(`Reddit → Wayback auto-archiver is now ${!current ? 'ENABLED' : 'DISABLED'}.`);
    }

    /* Add menu command so user can flip the switch at any time */
    GM.registerMenuCommand('Toggle auto-archiving', toggleEnabled);

    /* -------  main flow  ------- */
    (async function main() {
        if (!await isEnabled()) return;

        const postUrl = getCanonicalPostUrl();
        if (!postUrl) return;

        const postKey  = 'ts_' + postUrl;
        const lastSave = await store.get(postKey, 0);

        if (now() - lastSave < COOLDOWN_HOURS * 60 * 60 * 1000) return;

        const ok = await submitToWayback(postUrl);
        if (ok) {
            await store.set(postKey, Date.now());
            showToast('Wayback snapshot queued ✓');
        } else {
            showToast('Wayback snapshot failed ✗', 4500);
        }
    })();

    /* -------  helpers  ------- */

    // Canonicalise assorted reddit URL shapes into one stable string we can key by
    function getCanonicalPostUrl() {
        try {
            const url = new URL(location.href);

            // Handle redd.it short links → request will redirect to canonical comments page
            if (url.hostname === 'redd.it') return url.href.replace(/\/$/, '');

            // Standard comments permalink: keep scheme+host+pathname, drop query/hash
            // pathname format: /r/sub/comments/<postid>/[slug][/]
            if (/^\/r\/[^/]+\/comments\/[A-Za-z0-9]+/.test(url.pathname)) {
                return url.origin + url.pathname.replace(/\/$/, '');
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function submitToWayback(pageUrl) {
      return new Promise(res => {
        GM.xmlHttpRequest({
          method: 'GET',
          url   : 'https://web.archive.org/save/' + encodeURIComponent(pageUrl),
          headers: { 'User-Agent': navigator.userAgent },   // not strictly required but helps
          onload : r => {
            console.info('[Wayback] response', r.status, r.finalUrl);
            // Accept 200-399 (includes 202, 301, 302) as “queued”
            res(r.status >= 200 && r.status < 400);
          },
          onerror: e => { console.warn('[Wayback] XHR error', e); res(false); }
        });
      });
    }

})();
