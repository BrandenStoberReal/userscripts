// ==UserScript==
// @name         Wayback Quick-Save Button (draggable)
// @namespace    https://github.com/YourName/wayback-quick-save
// @version      1.1.1
// @description  Adds a small button to every page that you can drag anywhere; clicking submits the page to the Wayback Machine.
// @author       Branden Stober + GPT-o3
// @updateURL    https://raw.githubusercontent.com/BrandenStoberReal/userscripts/refs/heads/main/waybacksave.user.js
// @match        *://*/*
// @exclude      *://web.archive.org/*
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @run-at       document-end
// @connect      web.archive.org
// ==/UserScript==

(function () {
    'use strict';

    /* -----------------------------------------------------------
     * 1.  Inject button
     * --------------------------------------------------------- */
    const btn = document.createElement('button');
    btn.id = 'wbQuickSaveBtn';
    btn.textContent = 'Save to WB';
    document.body.appendChild(btn);

    /* -----------------------------------------------------------
     * 2.  Styling  (✱ NEW: cursor + user-select + transition class)
     * --------------------------------------------------------- */
    GM_addStyle(`
        #wbQuickSaveBtn {
            position: fixed;
            top: 10px;
            right: 10px;                 /* will switch to “left” after first drag */
            z-index: 2147483647;
            padding: 5px 9px;
            font: 12px/15px sans-serif;
            color: #fff;
            background: #000;
            border: none;
            border-radius: 3px;
            cursor: pointer;             /* normal cursor */
            user-select: none;           /* prevent accidental text highlights */
        }
        #wbQuickSaveBtn:hover { filter: brightness(1.15); }
        #wbQuickSaveBtn.wb--dragging { cursor: grabbing; }   /* during drag */
    `);

    /* -----------------------------------------------------------
     * 3.  Drag support  ✱ NEW ✱
     * --------------------------------------------------------- */
    let dragging = false;
    let startX, startY, startLeft, startTop;

    btn.addEventListener('mousedown', (ev) => {
        /* only the main (usually left) button starts a drag               */
        if (ev.button !== 0) return;

        dragging   = true;
        btn.classList.add('wb--dragging');

        /* record starting positions (button uses fixed positioning)       */
        const rect = btn.getBoundingClientRect();
        startX   = ev.clientX;
        startY   = ev.clientY;
        startLeft = rect.left;
        startTop  = rect.top;

        /* when we first drag we switch from “right:10px” to an explicit
           “left” value so that subsequent moves are expressed via ‘left’. */
        btn.style.left  = `${startLeft}px`;
        btn.style.top   = `${startTop}px`;
        btn.style.right = 'auto';

        /* capture further moves on the whole doc                           */
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',  onUp);

        /* prevent text selection while dragging                            */
        ev.preventDefault();
    });

    function onMove(ev) {
        if (!dragging) return;
        /* calculate delta movement                                         */
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        btn.style.left = `${startLeft + dx}px`;
        btn.style.top  = `${startTop  + dy}px`;
    }

    function onUp() {
        if (!dragging) return;
        dragging = false;
        btn.classList.remove('wb--dragging');

        /* keep the button inside the viewport (10 px margin)              */
        const rect = btn.getBoundingClientRect();
        const margin = 10;
        const maxLeft = window.innerWidth  - rect.width  - margin;
        const maxTop  = window.innerHeight - rect.height - margin;

        const clampedLeft = Math.min(Math.max(rect.left, margin), maxLeft);
        const clampedTop  = Math.min(Math.max(rect.top,  margin), maxTop);

        btn.style.left = `${clampedLeft}px`;
        btn.style.top  = `${clampedTop}px`;

        /* tidy up listeners                                               */
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',  onUp);
    }

    /* small helper so the click handler can ignore the click that ends a drag */
    function wasDragClick(ev) { return Math.abs(ev.clientX - startX) > 3
                                || Math.abs(ev.clientY - startY) > 3; }

    /* -----------------------------------------------------------
     * 4.  Click-to-save logic  (unchanged except for drag guard)
     * --------------------------------------------------------- */
    btn.addEventListener('click', (ev) => {
        /* If we *just* finished a drag, swallow this click                */
        if (dragging || wasDragClick(ev)) return;

        /* busy guard                                                      */
        if (btn.classList.contains('wb--busy')) return;

        btn.classList.add('wb--busy');
        btn.disabled   = true;
        btn.textContent = 'Saving…';

        const targetURL = encodeURIComponent(location.href);
        const apiURL    = `https://web.archive.org/save/${targetURL}`;

        const finish = (label) => {
            btn.textContent = label;
            setTimeout(() => {
                btn.disabled = false;
                btn.classList.remove('wb--busy');
                btn.textContent = 'Save to WB';
            }, 3000);        // 3-second cooldown
        };

        GM.xmlHttpRequest({
            method : 'POST',
            url    : apiURL,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data   : '',
            timeout: 30_000,
            onload   : (r)=> r.status>=200 && r.status<300 ? finish('✔ Saved!') : finish(`⚠ ${r.status}`),
            onerror  : ()=> finish('⚠ Error'),
            ontimeout: ()=> finish('⏲ Timeout'),
            onabort  : ()=> finish('✖ Aborted')
        });
    });
})();
