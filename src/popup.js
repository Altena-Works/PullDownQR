// PullDown QR — popup logic
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let pageUrl = null;       // the active tab's URL (for the current-page QR)
  let pageSettings = null;  // settings snapshot for rendering
  let activeHost = null;    // hostname of the active tab (for the per-site toggle)

  function flashStatus(msg) {
    const el = $('pageQrStatus');
    if (el) el.textContent = msg;
  }

  const POPUP_QR_PX = 196;  // fits the 248px popup width

  // Render the current page's URL as a QR into the popup canvas.
  function renderPageQR(url) {
    if (!url || typeof pdqrDrawQR !== 'function') return false;
    const s = pageSettings || (globalThis.PDQR_DEFAULTS || {});
    const cv = $('pageQr');
    const size = pdqrDrawQR(cv, url, {
      ecc: s.ecc,
      margin: (globalThis.PDQR_DEFAULTS || {}).margin,
      target: POPUP_QR_PX,
      darkColor: s.darkColor,
      lightColor: s.lightColor,
    });
    if (!size) return false;
    $('pageQrUrl').textContent = url;
    pageUrl = url;
    $('pageQrWrap').hidden = false;
    $('pageQrNote').hidden = true;
    return true;
  }
  // Exposed for the E2E harness (extension page only; not a content script).
  window.__pdqrRenderPageQR = renderPageQR;

  function copyPageImage() {
    const cv = $('pageQr');
    if (!cv || !cv.width) return;
    let wrote;
    try {
      const item = new ClipboardItem({
        'image/png': new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej()), 'image/png')),
      });
      wrote = navigator.clipboard.write([item]);
    } catch (e) { wrote = Promise.reject(e); }
    wrote.then(() => flashStatus('✓ QR画像をコピーしました'),
      () => flashStatus('コピー不可 — 右クリックで保存'));
  }

  function copyPageLink() {
    if (!pageUrl) return;
    navigator.clipboard.writeText(pageUrl).then(
      () => flashStatus('✓ リンクをコピーしました'),
      () => flashStatus('コピー不可'));
  }

  $('pageQr').addEventListener('click', copyPageImage);
  $('pageQrUrl').addEventListener('click', copyPageLink);

  function load() {
    pdqrGetSettings().then((s) => {
      $('enabled').checked = !!s.enabled;
      $('requireAlt').checked = !!s.requireAlt;
      $('skipSameSiteLinks').checked = !!s.skipSameSiteLinks;
      $('qrSize').value = s.qrSize;
      $('qrSizeVal').textContent = s.qrSize;
    });
  }

  function save(patch) {
    chrome.storage.sync.set(patch);
  }

  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('requireAlt').addEventListener('change', (e) => save({ requireAlt: e.target.checked }));
  $('skipSameSiteLinks').addEventListener('change', (e) => save({ skipSameSiteLinks: e.target.checked }));
  let sizeTimer = 0;
  $('qrSize').addEventListener('input', (e) => {
    $('qrSizeVal').textContent = e.target.value;
    const v = parseInt(e.target.value, 10);
    clearTimeout(sizeTimer);                     // debounce: sync has write quotas
    sizeTimer = setTimeout(() => save({ qrSize: v }), 200);
  });

  // Per-site disable toggle for the active tab's hostname. Pages without the
  // content script (chrome:// etc.) reject the message — keep the row hidden.
  async function initActivePage() {
    let url = null, tabId = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) { tabId = tab.id; url = tab.url || null; } // activeTab grants tab.url
    } catch (e) { /* ignore */ }
    // Fallback for pages where tab.url isn't available: ask the content script.
    // (Won't help if an old content script is still loaded — refresh the page.)
    if (!url && tabId != null) {
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'pdqr-get-host' });
        url = r && r.url;
      } catch (e) { /* no content script */ }
    }

    const s = await pdqrGetSettings();
    pageSettings = s;

    // Current-page QR (web pages only). Show the fallback note if the URL
    // isn't a web page or can't be encoded.
    if (!(url && /^https?:/i.test(url) && renderPageQR(url))) $('pageQrNote').hidden = false;

    // Per-site disable toggle (web pages only).
    let host = null;
    try { if (url && /^https?:/i.test(url)) host = new URL(url).hostname; } catch (e) { /* ignore */ }
    if (!host) return;
    activeHost = host;
    // Match the content script's subdomain-aware logic so the toggle reflects
    // the site's actual on/off state (e.g. a "google.com" rule disables
    // www.google.com too).
    const list = Array.isArray(s.excludedSites) ? s.excludedSites : [];
    $('siteHost').textContent = host;
    $('siteOff').checked = list.some((p) => pdqrHostMatchesPattern(host, p));
    $('siteRow').hidden = false;
    $('siteOff').addEventListener('change', async (e) => {
      // Re-read the latest list at write time (not the open-time snapshot) so a
      // concurrent edit on the options page isn't clobbered. Drop every rule
      // covering this host, then (if excluding) add an exact rule.
      const checked = e.target.checked;
      const fresh = await pdqrGetSettings();
      const cur = Array.isArray(fresh.excludedSites) ? fresh.excludedSites : [];
      const next = cur.filter((p) => !pdqrHostMatchesPattern(host, p));
      if (checked) next.push(host);
      save({ excludedSites: next });
    });
  }
  initActivePage();

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openShortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // Keep in sync if changed elsewhere (shortcut, options page, another window).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.enabled) $('enabled').checked = changes.enabled.newValue;
    if (changes.requireAlt) $('requireAlt').checked = changes.requireAlt.newValue;
    if (changes.skipSameSiteLinks) $('skipSameSiteLinks').checked = changes.skipSameSiteLinks.newValue;
    if (changes.qrSize) {
      $('qrSize').value = changes.qrSize.newValue;
      $('qrSizeVal').textContent = changes.qrSize.newValue;
    }
    if (changes.excludedSites && activeHost) {
      const list = Array.isArray(changes.excludedSites.newValue) ? changes.excludedSites.newValue : [];
      $('siteOff').checked = list.some((p) => pdqrHostMatchesPattern(activeHost, p));
    }
  });

  // Mac shows "Option（⌥）" instead of "Alt"; the shortcut hint reflects the
  // user's actual binding, platform-formatted (e.g. ⌥⇧Q on Mac).
  pdqrApplyModLabels();
  try {
    chrome.commands.getAll((cmds) => {
      const c = (cmds || []).find((x) => x.name === 'toggle-enabled');
      const kbd = $('scKbd');
      if (kbd) kbd.textContent = (c && c.shortcut) ? c.shortcut : '未設定';
    });
  } catch (e) { /* commands API unavailable */ }

  load();
})();
