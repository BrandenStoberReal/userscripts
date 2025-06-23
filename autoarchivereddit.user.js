// ==UserScript==
// @name         Reddit → Wayback auto-archiver
// @namespace    reddit-wayback-autosave
// @version      1.3.0
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
  const COOLDOWN_HOURS  = 24;   // do not resubmit same post within N hours
  const ENABLED_DEFAULT = true; // shipped state
  /* =================================== */

  /* ---------- tiny helpers ---------- */
  const HOUR       = 36e5;
  const KEY_GLOBAL = '_enabled';
  const KEY_QUEUE = '_archive_queue';
  const KEY_LAST_URL = '_last_url';  // Track the last URL even between page loads
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
    // Ensure we have a body to append to
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', () => showToast(msg, ms));
      return;
    }
    
    const el = document.createElement('div');
    el.className = 'wb-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    
    // Use setTimeout for better compatibility
    setTimeout(() => el.classList.add('show'), 10);
    
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  /* ---------- enable / disable ---------- */
  let isEnabled = ENABLED_DEFAULT; // Cache to avoid async lookups

  // Initialize enabled state as soon as possible
  store.get(KEY_GLOBAL, ENABLED_DEFAULT).then(val => {
    isEnabled = !!val;
    
    // Process any queued items from previous sessions
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
    
    // Only add if not already in queue
    if (!queue.some(item => item.url === url)) {
      queue.push({
        url: url,
        addedAt: Date.now()
      });
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
    
    // Process one item at a time to avoid overwhelming the Wayback Machine
    const item = queue[0];
    
    try {
      const success = await submitToWayback(item.url);
      
      if (success) {
        // Set cooldown timestamp
        const key = 'ts_' + item.url;
        await store.set(key, Date.now());
        log('Successfully archived and set cooldown for:', item.url);
      } else {
        log('Failed to archive, will retry later:', item.url);
      }
    } catch (err) {
      console.error('[Wayback-archiver] Error processing queue item:', err);
    }
    
    // Remove this item from the queue regardless of success
    await removeFromArchiveQueue(item.url);
    
    // Process the next item after a short delay
    if (queue.length > 1) {
      setTimeout(processArchiveQueue, 5000);
    }
  }

  /* ---------- main work ---------- */
  let processingPage = false; // Prevent multiple simultaneous runs

  async function handlePage() {
    if (processingPage) return;
    processingPage = true;
    
    try {
      if (!isEnabled) {
        processingPage = false;
        return;
      }

      // Here's the key change: We check if the current URL is a post
      // If not, we log it but don't try to archive it
      const canon = getCanonicalPostUrl(location.href);
      
      if (!canon) {
        log('Not a post page, skipping:', location.href);
        processingPage = false;
        return;
      }
      
      log('Detected post page:', canon);
      
      // Check against last URL from storage instead of in-memory variable
      const lastCanonical = await store.get(KEY_LAST_URL, null);
      
      if (canon === lastCanonical) {
        log('Same post as last time, skipping:', canon);
        processingPage = false;
        return;
      }
      
      // Update the last URL in storage
      await store.set(KEY_LAST_URL, canon);
      log('New post detected:', canon);

      const key = 'ts_' + canon;
      const last = await store.get(key, 0);
      if (Date.now() - last < COOLDOWN_HOURS * HOUR) {
        log('cool-down, already saved recently →', canon);
        processingPage = false;
        return;
      }

      // Show submission notification immediately
      showToast('Submitting to Wayback Machine...');
      
      // Add to persistent queue instead of trying to archive immediately
      await addToArchiveQueue(canon);
      
      // Start processing the queue
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
        headers: { 'User-Agent': navigator.userAgent },
        timeout: 30000, // 30 second timeout
        onload : r => {
          const success = r.status >= 200 && r.status < 400;
          log('Wayback response', r.status, url);
          
          if (success) {
            showToast('Successfully archived to Wayback Machine!');
          } else {
            showToast('Failed to archive to Wayback Machine. Will retry later.');
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
    // Force check the page immediately on startup
    setTimeout(handlePage, 100);
    
    // 1. Intercept push/replaceState
    const push = history.pushState, repl = history.replaceState;
    history.pushState = function() { 
      push.apply(this, arguments);
      setTimeout(handlePage, 100); // Slight delay to let page load
    };
    history.replaceState = function() { 
      repl.apply(this, arguments);
      setTimeout(handlePage, 100);
    };
    
    // 2. Listen for popstate
    window.addEventListener('popstate', () => setTimeout(handlePage, 100));
    
    // 3. Watch for URL changes using an interval (fallback)
    let lastUrl = location.href;
    setInterval(() => {
      if (lastUrl !== location.href) {
        lastUrl = location.href;
        handlePage();
      }
    }, 500); // Check more frequently (reduced from 1000ms)
    
    // 4. Run once on initial load
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', handlePage);
    } else {
      handlePage();
    }
    
    // 5. Set up periodic queue processing even if no navigation occurs
    setInterval(processArchiveQueue, 60000);
    
    // 6. Additional hook for Reddit's infinite scroll behavior
    // This detects content changes that might not trigger URL changes
    const observeDOM = (function(){
      const MutationObserver = window.MutationObserver || window.WebKitMutationObserver;
      
      return function(obj, callback){
        if (!obj || obj.nodeType !== 1) return;
        
        if (MutationObserver) {
          const mutationObserver = new MutationObserver(callback);
          mutationObserver.observe(obj, { childList: true, subtree: true });
          return mutationObserver;
        } else if (window.addEventListener) {
          obj.addEventListener('DOMNodeInserted', callback, false);
          obj.addEventListener('DOMNodeRemoved', callback, false);
          return {
            disconnect: function(){
              obj.removeEventListener('DOMNodeInserted', callback);
              obj.removeEventListener('DOMNodeRemoved', callback);
            }
          };
        }
      };
    })();
    
    // Start observing once the DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        observeDOM(document.body, function(mutations) {
          // Only trigger on significant DOM changes
          if (mutations.some(m => m.addedNodes.length > 3)) {
            setTimeout(handlePage, 200);
          }
        });
      });
    } else {
      observeDOM(document.body, function(mutations) {
        // Only trigger on significant DOM changes
        if (mutations.some(m => m.addedNodes.length > 3)) {
          setTimeout(handlePage, 200);
        }
      });
    }
  }
  
  // Set up all navigation hooks
  setupNavHooks();
})();
