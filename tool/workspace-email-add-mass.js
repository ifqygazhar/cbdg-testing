/* =========================================================================
 * workspace-email-add-mass.js
 * Otomasi browser console untuk Google Workspace — "Tambahkan pengguna" massal
 * (halaman Penyiapan Domain, workspace.google.com).
 *
 * Flow (lihat tool/flow.txt):
 *   1. Klik "Tambahkan pengguna" (buka dialog)
 *   2. Isi Nama depan / Nama belakang  → ambil dari API public (nama manusia asli)
 *      Nama Pengguna → turunan dari nama
 *      Email petunjuk login → selalu LOGIN_EMAIL di bawah
 *   3. Klik "Tambahkan pengguna" di dalam dialog → dialog tertutup → ulangi
 *
 * Cara pakai:
 *   1. Buka halaman Penyiapan Domain di browser (tab yang login ke workspace)
 *   2. F12 → Console → paste seluruh script ini → Enter
 *   3. Set COUNT / opsi di blok CONFIG sebelum paste kalau mau
 *   4. Stop kapan saja dengan:  window.__wsmStop = true
 * ========================================================================= */

(() => {
  'use strict';

  /* ----------------------------- CONFIG ---------------------------------- */
  const CONFIG = {
    COUNT: 10,                     // berapa banyak pengguna akan ditambahkan
    LOGIN_EMAIL: 'verifwebsitepro@gmail.com', // email petunjuk login (fixed)
    USERNAME_MODE: 'first.last',   // 'first' | 'last' | 'firstlast' | 'first.last'
    MIN_DELAY_MS: 1500,            // jeda acak antarnama (anti "saking cepetnya")
    MAX_DELAY_MS: 3500,
    DIALOG_WAIT_MS: 15000,         // max nunggu dialog terbuka/tertutup (ms)
    NAME_API: 'https://randomuser.me/api?results=', // sumber nama (primary)
    NAME_API_FALLBACK: 'https://random-data-api.com/api/users?size=', // fallback
  };
  /* ---------------------------- END CONFIG -------------------------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  let stopped = false;
  // Stop kapan saja dari console: __wsmStop()
  window.__wsmStop = () => { stopped = true; console.log('%c[WSM] Stop requested', 'color:#f66'); };

  /* ----------------------------- Nama dari API --------------------------- */

  async function fetchNames(count) {
    const names = new Map(); // dedupe by first+last biar username tak kembar
    const wanted = count;

    const push = (list) => {
      for (const n of list) {
        if (n.first && n.last) names.set(n.first + '|' + n.last, n);
      }
    };

    for (let page = 0; page < Math.ceil(wanted / 10) + 1 && names.size < wanted; page++) {
      let got = false;
      // 1) randomuser.me — nama lengkap real, CORS open
      if (!got) {
        try {
          const res = await fetch(`${CONFIG.NAME_API}10`);
          if (res.ok) { push((await res.json()).results.map((u) => ({ first: u.name.first, last: u.name.last }))); got = true; }
        } catch (e) { /* coba fallback */ }
      }
      // 2) random-data-api.com — fallback
      if (!got) {
        try {
          const res = await fetch(`${CONFIG.NAME_API_FALLBACK}10`);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          push((await res.json()).map((u) => ({ first: u.first_name, last: u.last_name })));
        } catch (e) {
          throw new Error('Semua API nama gagal: ' + e.message);
        }
      }
      await sleep(500); // sopan sama API
    }

    return [...names.values()];
  }

  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

  function makeUsername(n) {
    const f = n.first.toLowerCase(), l = n.last.toLowerCase();
    switch (CONFIG.USERNAME_MODE) {
      case 'first': return f;
      case 'last': return l;
      case 'firstlast': return f + l;
      default: return `${f}.${l}`; // 'first.last'
    }
  }

  /* --------------------------- DOM helpers ------------------------------- */

  // Isi input aman untuk React/Vue (native value setter + event lengkap)
  function fillInput(el, value) {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // Cari tombol berdasarkan teksnya (toleran whitespace)
  function findButton(scope, textRegex) {
    return [...(scope ?? document).querySelectorAll('button')]
      .find((b) => {
        const t = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
        return textRegex.test(t) && !b.disabled;
      }) || null;
  }

  const DIALOG_TEXT = /(tambahkan pengguna|add (user|users))/i;

  // Dialog yang sedang terbuka (harus memuat #firstname-input)
  function getOpenDialog() {
    const inputs = document.getElementById('firstname-input');
    if (!inputs) return null;
    // naik sampai elemen yang berperan sebagai dialog / overlay
    let node = inputs;
    while (node && node !== document.body) {
      const role = node.getAttribute && node.getAttribute('role');
      if (role === 'dialog' || /modal|dialog|popup/i.test(node.className || '')) return node;
      node = node.parentElement;
    }
    return inputs.closest('[class]')?.parentElement || document;
  }

  function dialogIsOpen() {
    const el = document.getElementById('firstname-input');
    return !!(el && el.offsetParent !== null); // ada & visible
  }

  async function waitFor(fn, timeoutMs, stepMs = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (stopped) throw new Error('stopped by user');
      const v = fn();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  // Buka dialog kalau belum terbuka
  async function openDialog() {
    if (dialogIsOpen()) return;
    const btn = findButton(document, DIALOG_TEXT);
    if (!btn) throw new Error('Tombol "Tambahkan pengguna" tidak ditemukan');
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    await waitFor(dialogIsOpen, CONFIG.DIALOG_WAIT_MS)
      || (() => { throw new Error('Dialog tidak terbuka setelah klik'); })();
  }

  /* ------------------------------- Main ---------------------------------- */

  async function run() {
    console.log('%c[WSM] Mulai — target ' + CONFIG.COUNT + ' pengguna', 'color:#0af;font-weight:bold');

    // Ambil semua nama sekali (hemat request)
    let names;
    try {
      names = await fetchNames(CONFIG.COUNT);
    } catch (e) {
      console.error('[WSM] Gagal ambil nama dari API:', e.message);
      return;
    }
    console.log('[WSM] Nama siap: ' + names.length);

    const results = [];
    let i = 0;
    while (i < CONFIG.COUNT && !stopped) {
      const n = names[i % names.length];
      const username = makeUsername(n);

      try {
        await openDialog();

        fillInput(document.getElementById('firstname-input'), cap(n.first));
        await sleep(rand(200, 600));
        fillInput(document.getElementById('lastname-input'), cap(n.last));
        await sleep(rand(200, 600));
        fillInput(document.getElementById('username-input'), username);
        await sleep(rand(200, 600));
        fillInput(document.getElementById('secondaryemail-input'), CONFIG.LOGIN_EMAIL);

        // Submit: tombol "Tambahkan pengguna" DI DALAM dialog
        const dialog = getOpenDialog();
        const submit = findButton(dialog, DIALOG_TEXT);
        if (!submit) throw new Error('Tombol submit di dialog tidak ditemukan');
        submit.click();

        // Tunggu dialog tertutup = submit diterima
        await waitFor(() => !dialogIsOpen(), CONFIG.DIALOG_WAIT_MS)
          || (() => { throw new Error('Dialog tidak tertutup setelah submit (cek manual — mungkin error form)'); })();

        i++;
        const full = `${cap(n.first)} ${cap(n.last)}`;
        results.push({ i, nama: full, username });
        console.log(`%c[WSM] ✓ (${i}/${CONFIG.COUNT}) ${full} → ${username}`, 'color:#0a0');

        await sleep(rand(CONFIG.MIN_DELAY_MS, CONFIG.MAX_DELAY_MS));
      } catch (e) {
        console.error(`%c[WSM] ✗ Gagal pada item ${i + 1} (${n.first} ${n.last}): ${e.message}`, 'color:#f00');
        // Kalau dialog masih nyala karena error form, tutup dulu
        if (dialogIsOpen()) {
          const cancel = findButton(getOpenDialog(), /(batalkan|cancel)/i);
          if (cancel) { cancel.click(); await sleep(500); }
        }
        if (stopped) break;
        console.log('[WSM] Retry item ini setelah 3 detik…');
        await sleep(3000);
      }
    }

    console.log('%c[WSM] Selesai', 'color:#0af;font-weight:bold');
    console.table(results);
    window.__wsmResults = results; // biar bisa di-grab lagi: copy(JSON.stringify(__wsmResults))
  }

  run();
})();
