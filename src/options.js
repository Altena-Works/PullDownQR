// PullDown QR — options logic with live preview
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const PREVIEW_URL = 'https://example.com/share?ref=pulldownqr';

  const BOOLEANS = ['enabled', 'requireAlt', 'showUrl',
    'skipSameSiteLinks', 'skipSamePathLinks', 'skipNavLinks'];
  const NUMBERS = ['hoverDelayMs', 'qrSize'];
  const STRINGS = ['ecc', 'position', 'darkColor', 'lightColor'];

  function current() {
    const s = {};
    BOOLEANS.forEach((k) => { s[k] = $(k).checked; });
    NUMBERS.forEach((k) => { s[k] = parseInt($(k).value, 10); });
    STRINGS.forEach((k) => { s[k] = $(k).value; });
    s.excludedSites = $('excludedSites').value
      .split('\n').map((t) => t.trim()).filter(Boolean);
    return s;
  }

  const MARGIN = (globalThis.PDQR_DEFAULTS || {}).margin ?? 4; // not user-settable

  function drawPreview(s) {
    const cv = $('pv');
    const size = pdqrDrawQR(cv, PREVIEW_URL, {
      ecc: s.ecc,
      margin: MARGIN,
      target: s.qrSize,
      darkColor: s.darkColor,
      lightColor: s.lightColor,
    });
    if (!size) return;
    cv.parentElement.style.background = s.lightColor; // match the tooltip frame
    $('pvUrl').textContent = s.showUrl ? PREVIEW_URL : '';
  }

  function refreshLabels(s) {
    $('hoverDelayMsVal').textContent = s.hoverDelayMs;
    $('qrSizeVal').textContent = s.qrSize;
  }

  // Debounced write: sliders and the textarea fire per keystroke/pixel, and
  // chrome.storage.sync enforces write-rate quotas.
  let saveTimer = 0;
  function onChange() {
    const s = current();
    refreshLabels(s);
    drawPreview(s);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.sync.set(s), 300);
  }

  function wireInputs() {
    [].concat(BOOLEANS, NUMBERS, STRINGS, ['excludedSites']).forEach((k) => {
      const el = $(k);
      el.addEventListener('input', onChange);
      el.addEventListener('change', onChange);
    });
  }

  function load() {
    pdqrGetSettings().then((s) => {
      BOOLEANS.forEach((k) => { $(k).checked = !!s[k]; });
      NUMBERS.forEach((k) => { $(k).value = s[k]; });
      STRINGS.forEach((k) => { $(k).value = s[k]; });
      $('excludedSites').value = (Array.isArray(s.excludedSites) ? s.excludedSites : []).join('\n');
      refreshLabels(s);
      drawPreview(s);
      // Attach change listeners only AFTER the controls hold real values, so a
      // save can never persist an un-loaded (default-false) checkbox while the
      // UI later shows it as on — which would silently disable a setting.
      wireInputs();
    });
  }

  // chrome:// links can't be opened via href; route through tabs API.
  $('shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  pdqrApplyModLabels();   // "Alt" -> "Option（⌥）" on Mac
  load();
})();
