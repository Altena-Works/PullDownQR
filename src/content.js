// PullDown QR — content script
// Detects mouseover on <a href> elements and renders a QR code of the link's
// URL in a floating, shadow-DOM tooltip. Everything is computed locally; no
// network requests and no data leaves the page.
(function () {
  'use strict';

  if (window.__pdqrLoaded) return;       // guard against double injection
  window.__pdqrLoaded = true;

  let settings = { ...(globalThis.PDQR_DEFAULTS || {}) };
  const SKIP_SCHEMES = globalThis.PDQR_SKIP_SCHEMES ||
    ['javascript:', 'about:', 'blob:', 'data:'];

  // Timings & thresholds.
  const HIDE_GRACE_MS = 250;          // leeway to move the pointer onto the card
  const TOAST_MS = 1100;              // how long the "copied" toast stays up
  const NATIVE_MENU_GRACE_MS = 3000;  // window to ignore the context-menu focus blur
  const DRAG_THRESHOLD_PX = 6;        // pointer travel that counts as a drag, not a click

  // ---- "unnecessary place" checks --------------------------------------
  // Navigation chrome: search-result tab strips, site navs, menu bars.
  const NAV_SELECTOR =
    'nav,[role="navigation"],[role="tablist"],[role="tab"],[role="menubar"],[role="menu"]';

  function inNavContainer(el) {
    return !!(el && typeof el.closest === 'function' && el.closest(NAV_SELECTOR));
  }

  // Subdomain-aware host matcher, shared with the popup via defaults.js.
  const hostMatchesPattern = globalThis.pdqrHostMatchesPattern ||
    ((host, pattern) => host === String(pattern || '').trim().toLowerCase());

  let siteBlocked = false;
  function recomputeSiteBlocked() {
    const host = location.hostname.toLowerCase();
    const list = Array.isArray(settings.excludedSites) ? settings.excludedSites : [];
    siteBlocked = list.some((p) => hostMatchesPattern(host, p));
    if (siteBlocked) hide();
  }

  // ---- DOM: build the shadow-DOM tooltip lazily ----------------------------
  let host = null;      // host element in the page
  let root = null;      // shadow root
  let card = null;      // visible card
  let canvas = null;    // offscreen canvas the QR is drawn on
  let qrImg = null;     // visible <img> (native context menu offers "Copy image")
  let urlLabel = null;  // URL text under the QR
  let toast = null;     // transient "copied" overlay
  let toastTimer = 0;

  function buildUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__pdqr_host';
    // Keep the host out of the page's own styling and event flow.
    host.style.cssText =
      'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;' +
      'pointer-events:none;';
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .card {
        position: fixed;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        align-items: center;
        width: max-content;            /* hug the QR, not the URL text */
        padding: 10px;
        background: #ffffff;
        border: 1px solid rgba(0,0,0,.12);
        border-radius: 14px;
        box-shadow: 0 6px 24px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.10);
        font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #1b1f24;
        opacity: 0;
        transform: translateY(-2px);
        transition: opacity .08s ease, transform .08s ease;
        pointer-events: none;
      }
      /* Interactive only while visible — an invisible card must never
         swallow the page's clicks. */
      .card.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
      .qr { display: block; border-radius: 4px; image-rendering: pixelated; cursor: pointer; }
      .url {
        box-sizing: border-box;
        margin-top: 8px;
        max-width: 100%;
        text-align: center;
        word-break: break-all;
        color: var(--pdqr-url, #4b5563);
        font-size: 11px;
        line-height: 1.45;
        user-select: text;
        cursor: pointer;
      }
      .url:hover { color: #2563eb; text-decoration: underline; }
      .toast {
        position: absolute;
        left: 50%;
        bottom: 10px;
        transform: translate(-50%, 4px);
        max-width: calc(100% - 16px);
        padding: 5px 12px;
        border-radius: 999px;
        background: rgba(16,21,28,.92);
        color: #fff;
        font-weight: 600;
        font-size: 12px;
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity .12s ease, transform .12s ease;
      }
      .toast.show { opacity: 1; transform: translate(-50%, 0); }
      .hidden { display: none; }
    `;
    root.appendChild(style);

    card = document.createElement('div');
    card.className = 'card';
    canvas = document.createElement('canvas'); // stays offscreen
    qrImg = document.createElement('img');
    qrImg.className = 'qr';
    qrImg.title = 'クリックで画像をコピー';
    qrImg.addEventListener('click', (e) => { e.stopPropagation(); copyQR(); });
    urlLabel = document.createElement('div');
    urlLabel.className = 'url';
    urlLabel.title = 'クリックでリンクをコピー';
    // Distinguish a plain click (copy the link) from a drag that selects text:
    // checking the actual pointer travel is robust where the selection state
    // isn't (Chrome defers collapsing when you click already-selected text).
    let urlDownPt = null;
    urlLabel.addEventListener('mousedown', (e) => {
      urlDownPt = { x: e.clientX, y: e.clientY };
    });
    urlLabel.addEventListener('click', (e) => {
      e.stopPropagation();
      const moved = urlDownPt &&
        (Math.abs(e.clientX - urlDownPt.x) > DRAG_THRESHOLD_PX ||
         Math.abs(e.clientY - urlDownPt.y) > DRAG_THRESHOLD_PX);
      urlDownPt = null;
      if (moved) return;            // dragged: a text selection, not a click
      copyLink();
    });
    toast = document.createElement('div');
    toast.className = 'toast';
    card.appendChild(qrImg);
    card.appendChild(urlLabel);
    card.appendChild(toast);
    root.appendChild(card);

    // Keep the card open while the pointer is over it, so the QR can be
    // right-clicked ("Copy image") or dragged out. Reaching the card also
    // aborts any pending switch to a link the pointer crossed on the way.
    card.addEventListener('mouseenter', () => {
      pointerInCard = true;
      cancelHideTimer();
      clearTimeout(showTimer);
      showTimer = 0;
      pendingAnchor = null;
      pendingUrl = null;
    });
    card.addEventListener('contextmenu', () => {
      cancelHideTimer();
      nativeMenuAt = performance.now();
    });
    card.addEventListener('mouseleave', (e) => {
      pointerInCard = false;
      const to = e.relatedTarget;
      if (to && currentAnchor && (to === currentAnchor || currentAnchor.contains(to))) return;
      if (e.buttons !== 0) {
        // Mid-drag (e.g. selecting the URL text): keep the card until the
        // button is released, and only hide if released outside it. Arm the
        // one-shot listener once per drag so repeated boundary crossings
        // don't stack handlers.
        if (!dragReleaseArmed) {
          dragReleaseArmed = true;
          document.addEventListener('mouseup', (ev) => {
            dragReleaseArmed = false;
            if (!withinCard(ev)) scheduleHide();
          }, { once: true, capture: true });
        }
        return;
      }
      scheduleHide();
    });

    (document.body || document.documentElement).appendChild(host);
  }

  // ---- QR rendering --------------------------------------------------------
  function renderQR(text) {
    const size = pdqrDrawQR(canvas, text, {
      ecc: settings.ecc,
      margin: settings.margin,
      target: settings.qrSize,
      darkColor: settings.darkColor,
      lightColor: settings.lightColor,
    });
    if (!size) return false;
    // Show via <img> so the native context menu offers copy/save-as.
    qrImg.src = canvas.toDataURL('image/png');
    qrImg.style.width = size + 'px';
    qrImg.style.height = size + 'px';
    qrImg.alt = 'QR: ' + text;
    // Pin the URL line to the QR's width so it wraps under the QR instead of
    // widening the card.
    urlLabel.style.width = size + 'px';
    return true;
  }

  // Copy the QR image to the clipboard. Passing a Promise to ClipboardItem
  // keeps the async toBlob tied to the click's user activation.
  function copyQR() {
    if (!canvas || !canvas.width) return;
    let wrote;
    try {
      const item = new ClipboardItem({
        'image/png': new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
        }),
      });
      wrote = navigator.clipboard.write([item]);
    } catch (e) {
      wrote = Promise.reject(e);
    }
    wrote.then(
      () => flashToast('✓ QR画像をコピーしました'),
      () => flashToast('コピー不可 — 右クリックで保存')
    );
  }

  // Copy the link URL (text) to the clipboard.
  function copyLink() {
    if (!currentUrl) return;
    let wrote;
    try { wrote = navigator.clipboard.writeText(currentUrl); }
    catch (e) { wrote = Promise.reject(e); }
    wrote.then(
      () => flashToast('✓ リンクをコピーしました'),
      () => flashToast('コピー不可')
    );
  }

  // True if the given CSS hex color is light (so dark text reads well on it).
  function isLightColor(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return true;                       // unknown -> assume light (safe default)
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.5;
  }

  function flashToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), TOAST_MS);
  }

  // ---- show / hide ---------------------------------------------------------
  let currentAnchor = null;
  let currentUrl = null;
  let pendingAnchor = null;  // anchor whose show is scheduled but not yet fired
  let pendingUrl = null;
  // The eligible link the pointer is physically over right now, regardless of
  // whether a card is shown. Lets a later Alt-keydown reveal the QR while the
  // cursor is already resting on a link (requireAlt mode).
  let hoveredAnchor = null;
  let hoveredUrl = null;
  let pointerInCard = false; // pointer is currently over the tooltip card
  let dragReleaseArmed = false;
  let showTimer = 0;
  let hideTimer = 0;
  let lastPointer = { x: 0, y: 0 };
  // Timestamp of the last right-click on the QR. Opening the native context
  // menu steals window focus — that one blur must not hide the card
  // mid-"Copy image". One-shot and time-bounded so it can never stick.
  let nativeMenuAt = 0;

  function eligibleUrl(anchor) {
    // anchor.href is a string for HTML <a>, but an SVGAnimatedString object for
    // SVG <a> elements — normalise both to a plain string before using it.
    let raw;
    try { raw = anchor.href; } catch (e) { return null; }
    let url = '';
    if (typeof raw === 'string') url = raw;
    else if (raw && typeof raw.baseVal === 'string') url = raw.baseVal;
    if (!url) {
      try { url = anchor.getAttribute('href') || ''; } catch (e) { /* ignore */ }
    }
    if (!url) return null;
    // Resolve to an absolute URL (also normalises relative SVG hrefs).
    try { url = new URL(url, location.href).href; } catch (e) { return null; }

    const lower = url.toLowerCase();
    for (const s of SKIP_SCHEMES) { if (lower.startsWith(s)) return null; }
    if (url.length > 2048) return null;          // beyond practical QR capacity

    try {
      const u = new URL(url);
      const here = new URL(location.href);
      const samePage = u.origin === here.origin && u.pathname === here.pathname;
      // Same site you're already on: in-app navigation (GitHub commits, SNS,
      // dashboards). A QR is for opening a link ELSEWHERE, so default to
      // external links only.
      if (settings.skipSameSiteLinks &&
          globalThis.pdqrSameSite && globalThis.pdqrSameSite(u.hostname, here.hostname)) {
        return null;
      }
      // Same path, only query/hash differ: search-result tabs, pagers, sort
      // and filter links — page UI, not destinations worth a QR.
      if (samePage && settings.skipSamePathLinks) return null;
      // Even with that check off, pure #fragment jumps stay suppressed.
      if (samePage && u.search === here.search && u.hash) return null;
    } catch (e) { /* ignore */ }

    return url;
  }

  function positionCard(anchor) {
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const pad = 8;
    const clamp = (x, y) => [
      Math.max(pad, Math.min(x, vw - cw - pad)),
      Math.max(pad, Math.min(y, vh - ch - pad)),
    ];
    // The interactive card must never end up under the pointer: it would
    // steal hit-testing from the link and swallow clicks.
    const overPointer = (x, y) =>
      lastPointer.x >= x && lastPointer.x <= x + cw &&
      lastPointer.y >= y && lastPointer.y <= y + ch;

    let x, y;
    if (settings.position === 'cursor') {
      [x, y] = clamp(lastPointer.x + 14, lastPointer.y + 16);
      if (overPointer(x, y)) {
        // Clamped onto the cursor (bottom/right edge): flip to above-left.
        [x, y] = clamp(lastPointer.x - cw - 14, lastPointer.y - ch - 16);
      }
    } else {
      const rect = anchor.getBoundingClientRect();
      x = rect.left;
      y = rect.bottom + 8;
      // Flip above the link if there's no room below.
      if (y + ch + pad > vh && rect.top - ch - 8 > 0) {
        y = rect.top - ch - 8;
      }
      [x, y] = clamp(x, y);
      if (overPointer(x, y)) {
        const alternatives = [
          [rect.left, rect.top - ch - 8],  // above
          [rect.right + 8, rect.top],      // beside, right
          [rect.left - cw - 8, rect.top],  // beside, left
        ];
        for (const [ax, ay] of alternatives) {
          const [nx, ny] = clamp(ax, ay);
          if (!overPointer(nx, ny)) { x = nx; y = ny; break; }
        }
      }
    }
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }

  function show(anchor, url) {
    showTimer = 0;                 // the scheduled timer has now fired
    pendingAnchor = null;
    pendingUrl = null;
    if (!anchor.isConnected) {     // the link vanished during the delay
      hide();
      return;
    }
    cancelHideTimer();
    buildUI();
    if (!renderQR(url)) { hide(); return; }   // don't leave a stale card up
    card.style.background = settings.lightColor || '#ffffff';
    // Keep the URL text legible whatever background color the user picked.
    const lightBg = isLightColor(settings.lightColor || '#ffffff');
    card.style.setProperty('--pdqr-url', lightBg ? '#4b5563' : '#cbd5e1');
    urlLabel.textContent = settings.showUrl ? url : '';
    urlLabel.classList.toggle('hidden', !settings.showUrl);
    // Make it measurable, then position, then fade in.
    card.style.visibility = 'hidden';
    card.classList.add('show');
    positionCard(anchor);
    card.style.visibility = '';
    currentAnchor = anchor;
    currentUrl = url;
  }

  function hide(keepPendingShow) {
    if (!keepPendingShow) {
      clearTimeout(showTimer);
      showTimer = 0;
      pendingAnchor = null;
      pendingUrl = null;
    }
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (card) card.classList.remove('show');
    if (toast) { toast.classList.remove('show'); clearTimeout(toastTimer); }
    currentAnchor = null;
    currentUrl = null;
  }

  function cancelHideTimer() {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }

  function scheduleHide() {
    cancelHideTimer();
    // keepPendingShow: a grace-expiry hide must not cancel a newer link's
    // pending show (hoverDelayMs can be configured above the grace).
    hideTimer = setTimeout(() => hide(true), HIDE_GRACE_MS);
  }

  // Is the event happening inside our tooltip (shadow DOM included)?
  function withinCard(e) {
    return !!(host && typeof e.composedPath === 'function' && e.composedPath().includes(host));
  }

  function scheduleShow(anchor, url, altKey) {
    if (!settings.enabled) return;
    // Back on the link whose card is already visible: keep it. This must
    // precede the Alt gate — Alt gates creating a card, not keeping one.
    if (anchor === currentAnchor && url === currentUrl) {
      cancelHideTimer();
      return;
    }
    // Crossing between children of the same link must not restart the delay.
    if (showTimer && anchor === pendingAnchor && url === pendingUrl) return;
    if (settings.requireAlt && !altKey) return;
    // Switching to a different link: let the old card fade on the grace timer
    // instead of vanishing instantly — the pointer may be travelling to it
    // across this link, and reaching it (mouseenter) still rescues it.
    if (currentAnchor && anchor !== currentAnchor) scheduleHide();
    clearTimeout(showTimer);
    pendingAnchor = anchor;
    pendingUrl = url;
    const delay = Math.max(0, settings.hoverDelayMs | 0);
    showTimer = setTimeout(() => show(anchor, url), delay);
  }

  // ---- event wiring --------------------------------------------------------
  function findAnchor(node) {
    if (!node || typeof node.closest !== 'function') return null;
    return node.closest('a[href]');
  }

  document.addEventListener('mouseover', (e) => {
    if (!settings.enabled || siteBlocked) return;
    const anchor = findAnchor(e.target);
    if (!anchor) return;
    if (settings.skipNavLinks && inNavContainer(anchor)) return;
    const url = eligibleUrl(anchor);
    if (!url) return;
    hoveredAnchor = anchor;
    hoveredUrl = url;
    lastPointer = { x: e.clientX, y: e.clientY };
    scheduleShow(anchor, url, e.altKey);
  }, true);

  document.addEventListener('mouseout', (e) => {
    // Clear the hovered-link tracking when the pointer truly leaves it (not
    // into a descendant or onto the card). Done before the card-state guard
    // below so it runs even when no card is shown (requireAlt, Alt not held).
    const outA = findAnchor(e.target);
    if (outA && outA === hoveredAnchor) {
      const rt = e.relatedTarget;
      if (!rt || (!hoveredAnchor.contains(rt) && rt !== host)) {
        hoveredAnchor = null;
        hoveredUrl = null;
      }
    }
    if (!currentAnchor && !showTimer) return;
    const anchor = findAnchor(e.target);
    if (anchor && anchor === currentAnchor) {
      const to = e.relatedTarget;
      // Into a descendant of the link, or onto the card itself: keep it.
      if (to && (anchor.contains(to) || to === host)) return;
      scheduleHide();
    } else if (showTimer && anchor && findAnchor(e.relatedTarget) !== anchor) {
      clearTimeout(showTimer);
      showTimer = 0;
      pendingAnchor = null;
      pendingUrl = null;
    }
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!settings.enabled || siteBlocked) return;
    lastPointer = { x: e.clientX, y: e.clientY };
    nativeMenuAt = 0;              // real pointer movement: no menu is tracking
    // The shown link may have been detached by an SPA re-render under a
    // stationary cursor; the first move afterwards clears the orphaned card.
    if (currentAnchor && !currentAnchor.isConnected) { hide(); return; }
    if (settings.position === 'cursor' && card && card.classList.contains('show') &&
        currentAnchor && !hideTimer) {
      // Freeze once the pointer leaves the link (hideTimer armed) or is over
      // the card — chasing the cursor would make the card unreachable.
      if (withinCard(e)) return;
      positionCard(currentAnchor);
    }
  }, true);

  // Dismiss on interaction / navigation noise. Only act when something is on
  // screen or pending, so these high-frequency handlers stay cheap otherwise.
  const hideIfActive = () => { if (currentAnchor || showTimer || hideTimer) hide(); };
  window.addEventListener('scroll', hideIfActive, true);
  window.addEventListener('wheel', hideIfActive, { passive: true, capture: true });
  document.addEventListener('mousedown', (e) => {
    if (withinCard(e)) {
      if (e.button === 2) return;                  // context menu on the QR
      const t = e.composedPath()[0];
      if (t === qrImg || t === urlLabel) return;   // click-to-copy / select text
      hide();                                      // click-to-dismiss elsewhere
      return;
    }
    hide();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hide(); return; }
    // requireAlt mode: pressing Alt/Option (⌥ maps to key 'Alt' on Mac) while
    // already resting on a link reveals its QR without re-entering the link.
    if (e.key === 'Alt' && settings.enabled && settings.requireAlt &&
        !siteBlocked && hoveredAnchor && hoveredAnchor !== currentAnchor) {
      // Re-check eligibility at reveal time (settings may have changed since
      // the link was first hovered).
      if (settings.skipNavLinks && inNavContainer(hoveredAnchor)) return;
      const u = eligibleUrl(hoveredAnchor);
      if (u) scheduleShow(hoveredAnchor, u, true);
    }
  }, true);
  document.addEventListener('keyup', (e) => {
    // "Show only while held": releasing Alt/Option hides the QR in requireAlt
    // mode — unless the pointer has moved onto the card (to copy / right-click)
    // or a native context menu was just opened, where tearing it down would
    // cancel the user's action.
    if (e.key === 'Alt' && settings.requireAlt) {
      if (pointerInCard) return;          // interacting with the card
      if (dragReleaseArmed) return;       // mid text-selection drag off the card
      if (nativeMenuAt && performance.now() - nativeMenuAt < NATIVE_MENU_GRACE_MS) return;
      hide();
    }
  }, true);
  window.addEventListener('blur', () => {
    // Suppress only the blur caused by the QR's own context menu, once,
    // and only within a short window — later blurs (tab/app switch) hide.
    if (nativeMenuAt && performance.now() - nativeMenuAt < NATIVE_MENU_GRACE_MS) {
      nativeMenuAt = 0;
      return;
    }
    hide();
  });
  window.addEventListener('focus', () => { nativeMenuAt = 0; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hide();
  });
  // SPA navigation: the hovered link is often detached. popstate/hashchange
  // fire across the isolated world; pushState/replaceState do not (and can't be
  // patched from here), so those are caught by the isConnected check on the
  // next mousemove above.
  window.addEventListener('popstate', () => hide());
  window.addEventListener('hashchange', () => hide());

  // ---- settings sync -------------------------------------------------------
  pdqrGetSettings().then((s) => { settings = s; recomputeSiteBlocked(); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let touched = false;
    for (const key in changes) {
      const ch = changes[key];
      // A removed key has no newValue — restore the default rather than store
      // undefined (which would silently disable settings until the next reload).
      settings[key] = ('newValue' in ch) ? ch.newValue : (globalThis.PDQR_DEFAULTS || {})[key];
      touched = true;
    }
    if (touched) recomputeSiteBlocked();
    if (touched && (!settings.enabled)) hide();
    // Re-render live if a QR is currently shown. A grace-period hide that was
    // already counting down must survive the re-render, or the card would be
    // orphaned on screen with the pointer long gone.
    if (touched && card && card.classList.contains('show') && currentAnchor && currentUrl) {
      const hadPendingHide = hideTimer !== 0;
      show(currentAnchor, currentUrl);
      if (hadPendingHide) scheduleHide();
    }
  });

  // Lets the popup read the active tab's URL (for the current-page QR) and host
  // (for the per-site toggle) without needing tabs/host permissions.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'pdqr-get-host') {
      sendResponse({ host: location.hostname, url: location.href });
    }
  });
})();
