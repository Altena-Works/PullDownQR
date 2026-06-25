// Shared default settings + storage helper.
// Loaded in every context: content script (isolated world), service worker
// (via importScripts), and the popup / options pages (via <script src>).
(function () {
  'use strict';

  const DEFAULTS = {
    enabled: true,        // master on/off
    requireAlt: false,    // if true, only show the QR while ALT is held during hover
    hoverDelayMs: 60,     // delay before the QR appears after the cursor lands on a link
    qrSize: 184,          // target QR size in CSS pixels
    ecc: 'M',             // error correction level: L / M / Q / H
    margin: 4,            // quiet-zone width in modules (4 = spec minimum)
    showUrl: true,        // show the URL text beneath the QR
    position: 'link',     // 'link' = anchored to the link, 'cursor' = follow the pointer
    darkColor: '#10151c', // module color
    lightColor: '#ffffff',// background color
    // "Unnecessary place" checks:
    skipSameSiteLinks: true, // skip links to the SAME site you're already on
                             // (in-app navigation: GitHub commits, SNS, dashboards).
                             // A QR is mainly useful for opening a link elsewhere,
                             // so default to external links only.
    skipSamePathLinks: true, // skip links to the current page's own path (search
                             // tabs, pagers, filters — only the query differs)
    skipNavLinks: true,      // skip links inside <nav> / role=navigation/tab etc.
    excludedSites: []        // hostnames where the extension is fully off
                             // ("google.com" matches subdomains too)
  };

  // Schemes we never render a QR for (not useful as a QR target).
  const SKIP_SCHEMES = ['javascript:', 'about:', 'blob:', 'data:'];

  globalThis.PDQR_DEFAULTS = DEFAULTS;
  globalThis.PDQR_SKIP_SCHEMES = SKIP_SCHEMES;

  // Host matcher shared by the content script (which sites to disable on) and
  // the popup's per-site toggle, so both agree. "google.com" matches
  // google.com and any subdomain; a leading "*." is accepted too.
  globalThis.pdqrHostMatchesPattern = function (host, pattern) {
    pattern = String(pattern || '').trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith('*.')) pattern = pattern.slice(2);
    host = String(host || '').toLowerCase();
    return host === pattern || host.endsWith('.' + pattern);
  };

  // Same "site" = same host, or one host is a subdomain of the other
  // (example.com ↔ www.example.com ↔ gist.example.com). This deliberately
  // does NOT collapse siblings under a public suffix (a.github.io vs
  // b.github.io stay distinct), avoiding the Public Suffix List entirely.
  globalThis.pdqrSameSite = function (hostA, hostB) {
    hostA = String(hostA || '').toLowerCase();
    hostB = String(hostB || '').toLowerCase();
    if (!hostA || !hostB) return false;            // non-host URLs (mailto:, tel:) are never "same site"
    return hostA === hostB ||
      hostA.endsWith('.' + hostB) || hostB.endsWith('.' + hostA);
  };

  // Platform-aware modifier labels. On macOS the DOM's `altKey` is the
  // Option (⌥) key, so the hover-modifier feature already works — only the
  // wording differs.
  globalThis.pdqrIsMac = function () {
    try {
      const p = navigator.userAgentData && navigator.userAgentData.platform;
      if (p) return /mac/i.test(p);
    } catch (e) { /* fall through */ }
    return /Mac/i.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));
  };
  // Show both names so users on either platform recognise the key; the
  // platform's own name comes first.
  globalThis.pdqrAltLabel = function () {
    return pdqrIsMac() ? 'Option（⌥）/ Alt' : 'Alt / Option（⌥）';
  };
  // Fill any .modkey element with the platform's modifier name.
  globalThis.pdqrApplyModLabels = function (rootEl) {
    const label = pdqrAltLabel();
    (rootEl || document).querySelectorAll('.modkey').forEach((el) => {
      el.textContent = label;
    });
  };

  // Resolve settings, falling back to defaults for any unset key.
  globalThis.pdqrGetSettings = function () {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (items) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve({ ...DEFAULTS });
          } else {
            resolve(items || { ...DEFAULTS });
          }
        });
      } catch (e) {
        resolve({ ...DEFAULTS });
      }
    });
  };
})();
