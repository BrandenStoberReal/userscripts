// ==UserScript==
// @name         Reddit → Wayback auto-archiver
// @namespace    reddit-wayback-autosave
// @version      1.0.0
// @description  When you open a Reddit post, automatically submit it to the Wayback Machine once every N hours.
// @author       Branden Stober + GPT-o3
// @updateURL    https://raw.githubusercontent.com/BrandenStoberReal/userscripts/refs/heads/main/autoarchivereddit.user.js
// @match        https://www.reddit.com/r/*/comments/*
// @match        https://old.reddit.com/r/*/comments/*
// @match        https://np.reddit.com/r/*/comments/*
// @match        https://redd.it/*
// @icon         https://www.redditstatic.com/desktop2x/img/favicon/apple-icon-57x57.png
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(() => {
    /* =========  USER OPTIONS  ========= */
    const COOLDOWN_HOURS = 24;         // How long to wait before re-submitting the SAME post
    const ENABLED_DEFAULT = true;      // Set to false if you want it shipped disabled
    /* ================================== */

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
        if (!postUrl) return;   // not a recognised post permalink (shouldn’t happen because of @match)

        const postKey = 'ts_' + postUrl;                     // storage key for this post
        const lastSaved = await store.get(postKey, 0);

        if (now() - lastSaved < COOLDOWN_HOURS * hours) {
            console.info('[Wayback auto-archiver] Cooldown active for', postUrl);
            return;
        }

        submitToWayback(postUrl).then(ok => {
            if (ok) store.set(postKey, now());
        });
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
        const archiveApi = 'https://web.archive.org/save/' + encodeURIComponent(pageUrl);
        console.info('[Wayback auto-archiver] submitting', pageUrl);

        return new Promise(resolve => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: archiveApi,
                headers: { 'User-Agent': navigator.userAgent },
                onload: resp => {
                    console.info('[Wayback auto-archiver] Wayback response', resp.status);
                    resolve(resp.status === 200 || resp.status === 302);
                },
                onerror: err => {
                    console.warn('[Wayback auto-archiver] archive request failed', err);
                    resolve(false);
                },
            });
        });
    }
})();
