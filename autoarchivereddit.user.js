// ==UserScript==
// @name         Reddit → Wayback Auto-Archiver (v4.2 Final)
// @namespace    reddit-wayback-autosave
// @version      4.2.0
// @description  A clean, stable, and robust script to auto-submit Reddit posts and their content. With intelligent URL construction for embeds.
// @author       Branden Stober (refactored by AI)
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

class RedditArchiver {
    constructor() {
        this.settings = {
            COOLDOWN_HOURS: 24,
            ENABLED_DEFAULT: true,
            DEBUG_LOGGING: true,
        };
        this.keys = {
            GLOBAL_ENABLED: '_enabled',
            ARCHIVE_QUEUE: '_archive_queue',
            LAST_PROCESSED_URL: '_last_processed_url',
        };
        this.state = {
            isEnabled: this.settings.ENABLED_DEFAULT,
            isQueueProcessing: false,
            lastProcessedUrl: null,
        };
        this.init();
    }

    log(...args) {
        if (this.settings.DEBUG_LOGGING) {
            console.log('[Wayback-archiver]', ...args);
        }
    }

    async init() {
        this.injectStyles();
        this.injectNavigationListener();
        await this.loadState();
        this.setupEventListeners();
        this.log('Userscript initialized and ready.');
    }

    async loadState() {
        this.state.isEnabled = await GM.getValue(this.keys.GLOBAL_ENABLED, this.settings.ENABLED_DEFAULT);
        this.state.lastProcessedUrl = await GM.getValue(this.keys.LAST_PROCESSED_URL, null);
        this.log(`State loaded. Enabled: ${this.state.isEnabled}`);
    }

    getCanonicalPostUrl(href) {
        try {
            const url = new URL(href);
            if (url.hostname === 'redd.it') {
                const p = url.pathname.replace(/^\/|\/$/g, '');
                return p ? `https://old.reddit.com/comments/${p}` : null;
            }
            const match = url.pathname.match(/\/(?:comments|gallery)\/([a-z0-9]+)/i);
            return (match && match[1]) ? `https://old.reddit.com/comments/${match[1]}` : null;
        } catch (e) {
            return null;
        }
    }

    async handlePageChange() {
        if (!this.state.isEnabled) return;

        try {
            const canonicalUrl = this.getCanonicalPostUrl(location.href);

            if (!canonicalUrl) {
                await GM.setValue(this.keys.LAST_PROCESSED_URL, '');
                return;
            }

            if (canonicalUrl === this.state.lastProcessedUrl) {
                return;
            }

            this.state.lastProcessedUrl = canonicalUrl;
            await GM.setValue(this.keys.LAST_PROCESSED_URL, canonicalUrl);

            const lastTimestamp = await GM.getValue('ts_' + canonicalUrl, 0);
            const cooldownMs = this.settings.COOLDOWN_HOURS * 36e5;
            if (Date.now() - lastTimestamp < cooldownMs) {
                this.log('Cool-down active for:', canonicalUrl);
                return;
            }

            this.log('New post detected:', canonicalUrl);
            const urlsToArchive = new Set([canonicalUrl]);
            const postContainer = await this.waitForElement('shreddit-post, div.thing');

            if (postContainer) {
                const contentUrls = this.extractUrlsFromContainer(postContainer);
                contentUrls.forEach(url => urlsToArchive.add(url));
            }

            this.log(`Found ${urlsToArchive.size} total URLs to queue.`);
            for (const url of urlsToArchive) {
                await this.addToQueue(url);
            }
            this.processQueue();

        } catch (err) {
            console.error('[Wayback-archiver] Error in handlePageChange:', err);
        }
    }

    async handleInteraction(event) {
        if (!this.state.isEnabled) return;
        
        const revealButton = event.target.closest('.nsfw-see-more button, div[data-testid="post-content"] button, button[data-testid="nsfw-button-ok"]');
        if (revealButton) {
            const postContainer = revealButton.closest('shreddit-post, div.thing');
            if (!postContainer) return;

            this.log('Sensitive content reveal clicked. Waiting for content...');
            setTimeout(async () => {
                const newUrls = this.extractUrlsFromContainer(postContainer);
                if (newUrls.length > 0) {
                    this.log('Found new content post-click:', newUrls);
                    for (const url of newUrls) {
                        await this.addToQueue(url);
                    }
                    this.processQueue();
                }
            }, 1500);
        }
    }

    extractUrlsFromContainer(container) {
        const urls = new Set();
        const selectors = [
            'a[data-click-id="body"]', 'a.title',
            'div[data-test-id="post-content"] a', '.expando .md a',
            'div[data-media-container] a',
            'shreddit-player[src]',
            'iframe[src]',
            'a.videoLink'
        ].join(', ');

        container.querySelectorAll(selectors).forEach(el => {
            const href = el.getAttribute('href');
            let potentialUrl = el.src || href;

            if (el.tagName === 'A' && href && href.startsWith('/')) {
                const innerMedia = el.querySelector('video[poster], img[src]');
                if (innerMedia) {
                    try {
                        const sourceUrl = new URL(innerMedia.poster || innerMedia.src);
                        const originHost = sourceUrl.hostname.split('.').slice(-2).join('.'); // Handles subdomains like media.redgifs.com
                        potentialUrl = `https://${originHost}${href}`;
                        this.log(`Constructed URL: ${potentialUrl}`);
                    } catch (e) { /* Fallback to href */ }
                }
            }

            if (potentialUrl && potentialUrl.startsWith('http')) {
                try {
                    if (!/reddit\.com|redd\.it/.test(new URL(potentialUrl).hostname)) {
                        urls.add(potentialUrl);
                    }
                } catch (e) { /* Ignore invalid URLs */ }
            }
        });
        return Array.from(urls);
    }

    async addToQueue(url) {
        const queue = await GM.getValue(this.keys.ARCHIVE_QUEUE, []);
        if (!queue.some(item => item && item.url === url)) {
            queue.push({ url, addedAt: Date.now() });
            await GM.setValue(this.keys.ARCHIVE_QUEUE, queue);
            this.showToast('Added to archive queue.');
        }
    }

    async processQueue() {
        if (this.state.isQueueProcessing || !this.state.isEnabled) return;
        
        const tasks = await GM.getValue(this.keys.ARCHIVE_QUEUE, []);
        if (tasks.length === 0) return;

        this.state.isQueueProcessing = true;
        this.log(`Starting batch processing of ${tasks.length} items.`);
        const succeededUrls = [];
        const failedUrls = [];

        try {
            for (const item of tasks) {
                if (!item || typeof item.url !== 'string') continue;
                const success = await this.submitToWayback(item.url);
                if (success) {
                    await GM.setValue('ts_' + item.url, Date.now());
                    succeededUrls.push(item.url);
                } else {
                    failedUrls.push(item.url);
                }
            }
        } finally {
            if (succeededUrls.length > 0) {
                const currentQueue = await GM.getValue(this.keys.ARCHIVE_QUEUE, []);
                const finalQueue = currentQueue.filter(item => !(item && item.url && succeededUrls.includes(item.url)));
                await GM.setValue(this.keys.ARCHIVE_QUEUE, finalQueue);
            }
            this.state.isQueueProcessing = false;
            this.log(`Batch complete. ${succeededUrls.length} OK, ${failedUrls.length} failed.`);
            if (tasks.length > 0) {
                this.showToast(`Archive complete: ${succeededUrls.length} OK, ${failedUrls.length} failed.`, 5000);
            }
        }
    }

    submitToWayback(url) {
        const saveUrl = 'https://web.archive.org/save/' + encodeURIComponent(url);
        return new Promise(resolve => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: saveUrl,
                timeout: 60000,
                onload: r => resolve(r.status >= 200 && r.status < 400),
                onerror: () => resolve(false),
                ontimeout: () => resolve(false),
            });
        });
    }

    waitForElement(selector, context = document, timeout = 5000) {
        return new Promise(resolve => {
            const el = context.querySelector(selector);
            if (el) return resolve(el);
            const observer = new MutationObserver(() => {
                const observedEl = context.querySelector(selector);
                if (observedEl) {
                    observer.disconnect();
                    resolve(observedEl);
                }
            });
            observer.observe(context, { childList: true, subtree: true });
            setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
        });
    }

    setupEventListeners() {
        const debouncedHandler = (() => {
            let timer;
            return () => { clearTimeout(timer); timer = setTimeout(() => this.handlePageChange(), 500); };
        })();
        
        window.addEventListener('wayback_history_changed', debouncedHandler);
        document.body.addEventListener('click', (e) => this.handleInteraction(e), true);
        setInterval(() => this.processQueue(), 60000);
        
        GM.registerMenuCommand('Toggle auto-archiving', async () => {
            this.state.isEnabled = !this.state.isEnabled;
            await GM.setValue(this.keys.GLOBAL_ENABLED, this.state.isEnabled);
            const status = this.state.isEnabled ? 'ENABLED' : 'DISABLED';
            alert(`Reddit → Wayback auto-archiver is now ${status}.`);
            this.log(`Toggled via menu. Status: ${status}`);
        });

        debouncedHandler();
    }

    injectNavigationListener() {
        const scriptId = 'history-hook-script';
        const eventName = 'wayback_history_changed';
        if (document.getElementById(scriptId)) return;
        const script = document.createElement('script');
        script.id = scriptId;
        script.textContent = `(() => {
            if (window.top !== window.self) return;
            const dispatch = () => { try { window.dispatchEvent(new CustomEvent('${eventName}')) } catch (e) {} };
            const hist = history;
            const push = hist.pushState;
            const repl = hist.replaceState;
            hist.pushState = function(...args) { push.apply(this, args); dispatch(); };
            hist.replaceState = function(...args) { repl.apply(this, args); dispatch(); };
            window.addEventListener('popstate', dispatch);
        })();`;
        (document.head || document.documentElement).appendChild(script);
    }

    injectStyles() {
        GM.addStyle(`
            .wb-toast {
                position: fixed; bottom: 20px; right: 20px; max-width: 280px;
                padding: 10px 15px; font: 14px/1.4 system-ui, sans-serif;
                color: #fff; background: rgba(20, 20, 20, 0.9);
                border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,.3);
                opacity: 0; transform: translateY(15px);
                transition: opacity .3s, transform .3s;
                z-index: 2147483647; pointer-events: none;
            }
            .wb-toast.show { opacity: 1; transform: translateY(0); }
        `);
    }

    showToast(message, duration = 3500) {
        if (!document.body) {
            window.addEventListener('DOMContentLoaded', () => this.showToast(message, duration));
            return;
        }
        const el = document.createElement('div');
        el.className = 'wb-toast';
        el.textContent = message;
        document.body.appendChild(el);
        setTimeout(() => el.classList.add('show'), 10);
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 400);
        }, duration);
    }
}

new RedditArchiver();
