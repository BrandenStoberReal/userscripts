// ==UserScript==
// @name         Wayback Quick-Save Button
// @namespace    https://github.com/YourName/wayback-quick-save
// @version      1.0.0
// @description  Adds a small button to every page that sends the current URL to the Wayback Machine “Save Page Now” API.
// @author       Your Name
// @match        *://*/*
// @exclude      *://web.archive.org/*              // don’t show inside the archive itself
// @grant        GM.xmlHttpRequest                  // cross-origin POST without CORS pre-flight
// @grant        GM_addStyle
// @connect      web.archive.org
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    /*------------------------------------------------------------------------
     * 1.  Inject a small fixed-position button in the upper-right corner
     *------------------------------------------------------------------------*/
    const btn = document.createElement('button');
    btn.id = 'wbQuickSaveBtn';
    btn.textContent = 'Save to WB';
    document.body.appendChild(btn);

    /*------------------------------------------------------------------------
     * 2.  Minimal styling (tweak to taste)
     *------------------------------------------------------------------------*/
    GM_addStyle(`
        #wbQuickSaveBtn {
            position: fixed;
            top: 10px;
            right: 10px;
            z-index: 2147483647;            /* stay above everything */
            padding: 5px 9px;
            font: 12px/15px sans-serif;
            color: #fff;
            background: rgba(0, 0, 0, 0.7);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            opacity: 0.6;
            transition: opacity .2s ease-in-out;
        }
        #wbQuickSaveBtn:hover {
            opacity: 1;
        }
    `);

    /* -----------------------------------------------------------------------
     * 3.  Core logic – POST current page to Wayback
     * -------------------------------------------------------------------- */
    btn.addEventListener('click', () => {
    
        /* 1️⃣  Guard: if we are already saving, ignore further clicks           */
        if (btn.classList.contains('wb--busy')) return;
    
        /* 2️⃣  Enter “busy” state                                               */
        btn.classList.add('wb--busy');
        btn.disabled   = true;
        btn.textContent = 'Saving…';
    
        /* 3️⃣  Build & send the request                                         */
        const targetURL = encodeURIComponent(location.href);
        const apiURL    = `https://web.archive.org/save/${targetURL}`;
    
        /* Helper that ends the busy state + optional 3-second cooldown */
        const finish = (label) => {
            btn.textContent = label;
            setTimeout(() => {
                btn.disabled = false;
                btn.classList.remove('wb--busy');
                btn.textContent = 'Save to WB';
            }, 3000);                     // 3 s cooldown; tweak to taste
        };
    
        GM.xmlHttpRequest({
            method : 'POST',
            url    : apiURL,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data   : '',
            timeout: 30_000,
    
            onload  : (resp) => {
                if (resp.status >= 200 && resp.status < 300) {
                    finish('✔ Saved!');
                } else {
                    finish(`⚠ ${resp.status}`);
                }
            },
            onerror : () => finish('⚠ Error'),
            ontimeout: () => finish('⏲ Timeout'),
            onabort : () => finish('✖ Aborted')
        });
    });

})();
