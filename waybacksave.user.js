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
