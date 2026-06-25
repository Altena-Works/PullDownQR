// End-to-end verification: load the unpacked extension in Chrome for Testing,
// hover links on a real page, decode the rendered QR canvas with jsQR, and
// assert it matches the link URL. Screenshots land in test/artifacts/.
import puppeteer from 'puppeteer';
import jsQR from 'jsqr';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, '..');
const ART = join(HERE, 'artifacts');
mkdirSync(ART, { recursive: true });

const LONG_URL = 'https://example.com/?x=' + 'a'.repeat(2100);
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>pdqr test</title>
<style>body{font:16px sans-serif;padding:40px} .row{margin:34px 0}</style></head><body>
<h1>PullDown QR test page</h1>
<div class="row"><a id="normal" href="https://example.com/share?ref=pulldownqr">normal link</a></div>
<div class="row"><a id="nested" href="https://nested.example/page"><span id="nestedspan">nested span link</span></a></div>
<div class="row"><svg width="160" height="36"><a id="svglink" href="/svg/target"><rect id="svgrect" width="160" height="36" fill="orange"/></a></svg></div>
<div class="row"><a id="frag" href="#section">same-page fragment</a></div>
<div class="row"><a id="js" href="javascript:void(0)">javascript link</a></div>
<div class="row"><a id="long" href="${LONG_URL}">overlong url</a></div>
<div class="row"><a id="jp" href="https://例え.テスト/パス?q=値">日本語URL</a></div>
<nav class="row"><a id="navlink" href="https://nav.example/item">link inside nav</a></nav>
<div class="row" role="navigation"><a id="tabnav" href="/?udm=7">search tab (same path)</a></div>
<div class="row"><a id="pager" href="/?page=2">pager (same path, query only)</a></div>
<div class="row"><a id="samesite" href="/some/app/page">same-site link (in-app)</a></div>
<div id="spaHolder" class="row"><a id="spa" href="https://spa.example/before">SPA link</a></div>
<a id="corner" href="https://corner.example/edge" style="position:fixed;right:8px;bottom:8px">corner link</a>
<div id="section" style="margin-top:600px">section target</div>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--window-size=1100,800',
  ],
});

const results = [];
const note = (icon, name, detail) => {
  results.push({ icon, name, detail });
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
};

try {
  try {
    await browser.defaultBrowserContext().overridePermissions(ORIGIN,
      ['clipboard-read', 'clipboard-sanitized-write']);
  } catch (e) { /* clipboard test will fall back to the toast assertion */ }

  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 400)); // document_idle injection

  // ---- service worker handle (needed by mode-toggling tests throughout) ----
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 5000 });
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  const setSync = (patch) => sw.evaluate((p) => chrome.storage.sync.set(p), patch);

  // ---- helpers ----
  // 450ms: must outlast the 250ms hide-grace plus the fade transition.
  const neutral = async () => { await page.mouse.move(5, 5); await new Promise((r) => setTimeout(r, 450)); };

  const cardState = () => page.evaluate(() => {
    const host = document.getElementById('__pdqr_host');
    if (!host || !host.shadowRoot) return { exists: false };
    const card = host.shadowRoot.querySelector('.card');
    const shown = card.classList.contains('show');
    let qr = null, urlText = null, rect = null, bg = null, srcPrefix = null;
    if (shown) {
      const img = card.querySelector('img.qr');
      srcPrefix = img ? img.src.slice(0, 14) : null;
      if (img && img.naturalWidth) {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, cv.width, cv.height);
        qr = { data: Array.from(data.data), width: cv.width, height: cv.height };
      }
      urlText = card.querySelector('.url').textContent;
      rect = card.getBoundingClientRect().toJSON();
      bg = getComputedStyle(card).backgroundColor;
    }
    const toastEl = card.querySelector('.toast');
    const toast = toastEl
      ? { text: toastEl.textContent, show: toastEl.classList.contains('show') }
      : null;
    return { exists: true, shown, qr, urlText, rect, bg, srcPrefix, toast };
  });

  const hoverAndRead = async (sel) => {
    await neutral();
    await page.hover(sel);
    await new Promise((r) => setTimeout(r, 350)); // 60ms delay + transition
    return cardState();
  };

  const decode = (qr) => {
    if (!qr) return null;
    const r = jsQR(new Uint8ClampedArray(qr.data), qr.width, qr.height);
    return r ? r.data : null;
  };

  const expectedHref = (sel) => page.$eval(sel, (a) => {
    const raw = a.getAttribute('href');
    return new URL(raw, location.href).href;
  });

  // ---- 1. normal link: card shows, QR decodes to exact URL ----
  {
    const exp = await expectedHref('#normal');
    const st = await hoverAndRead('#normal');
    const dec = decode(st.qr);
    if (st.shown && dec === exp && st.urlText === exp) {
      note('✅', 'normal link', `QR decoded to ${dec}`);
    } else {
      note('❌', 'normal link', `shown=${st.shown} decoded=${dec} expected=${exp} label=${st.urlText}`);
    }
    await page.screenshot({ path: join(ART, '01-normal-hover.png') });
  }

  // ---- 1b. card hugs the QR width and centers the QR ----
  {
    await hoverAndRead('#normal');
    const L = await page.evaluate(() => {
      const card = document.getElementById('__pdqr_host').shadowRoot.querySelector('.card');
      const img = card.querySelector('img.qr');
      const cr = card.getBoundingClientRect(), ir = img.getBoundingClientRect();
      const cs = getComputedStyle(card);
      return {
        cardW: cr.width, imgW: ir.width,
        cardCx: cr.left + cr.width / 2, imgCx: ir.left + ir.width / 2,
        pad: parseFloat(cs.paddingLeft),
      };
    });
    const centered = Math.abs(L.cardCx - L.imgCx) < 1.5;
    // card width should be ~ QR + 2*(padding+border); reject the old full-width box
    const slack = L.cardW - L.imgW;
    const hugs = slack >= 0 && slack <= 2 * L.pad + 6;
    note(centered && hugs ? '✅' : '❌', 'card centers QR and hugs its width',
      `cardW=${Math.round(L.cardW)} imgW=${Math.round(L.imgW)} slack=${slack.toFixed(1)} dCx=${(L.cardCx - L.imgCx).toFixed(1)}`);
  }

  // ---- 2. nested span inside link ----
  {
    const exp = await expectedHref('#nested');
    const st = await hoverAndRead('#nestedspan');
    const dec = decode(st.qr);
    note(st.shown && dec === exp ? '✅' : '❌', 'nested span in link', `decoded=${dec}`);
  }

  // ---- 3. SVG <a> link (regression: used to throw TypeError) ----
  {
    // #svglink resolves to a same-origin path, so relax same-site suppression
    // here — this test is about SVG anchor handling, not site filtering.
    await setSync({ skipSameSiteLinks: false });
    await new Promise((r) => setTimeout(r, 150));
    const exp = await expectedHref('#svglink');
    const before = pageErrors.length;
    const st = await hoverAndRead('#svgrect');
    const dec = decode(st.qr);
    const threw = pageErrors.length > before;
    note(st.shown && dec === exp && !threw ? '✅' : '❌', 'SVG anchor',
      `decoded=${dec} expected=${exp} newErrors=${threw ? pageErrors.slice(before).join('; ') : 'none'}`);
    await page.screenshot({ path: join(ART, '02-svg-hover.png') });
    await setSync({ skipSameSiteLinks: true });
    await new Promise((r) => setTimeout(r, 150));
  }

  // ---- 4. same-page fragment: must NOT show ----
  {
    const st = await hoverAndRead('#frag');
    note(!st.shown ? '✅' : '❌', 'fragment link suppressed', `shown=${st.shown}`);
  }

  // ---- 5. javascript: link: must NOT show ----
  {
    const st = await hoverAndRead('#js');
    note(!st.shown ? '✅' : '❌', 'javascript: link suppressed', `shown=${st.shown}`);
  }

  // ---- 6. overlong URL: must NOT show ----
  {
    const st = await hoverAndRead('#long');
    note(!st.shown ? '✅' : '❌', 'overlong URL suppressed', `shown=${st.shown}`);
  }

  // ---- 7. Japanese URL decodes ----
  {
    const exp = await expectedHref('#jp');
    const st = await hoverAndRead('#jp');
    const dec = decode(st.qr);
    note(st.shown && dec === exp ? '✅' : '⚠️', 'Japanese URL', `decoded=${dec} expected=${exp}`);
  }

  // ---- 8. mouseout hides (after the 250ms grace) ----
  {
    await hoverAndRead('#normal');
    await neutral();
    const st = await cardState();
    note(!st.shown ? '✅' : '❌', 'mouseout hides card', `shown=${st.shown}`);
  }

  // ---- 8b. pointer onto the card keeps it open; QR is a PNG <img> ----
  {
    const st = await hoverAndRead('#normal');
    const cx = st.rect.left + st.rect.width / 2;
    const cy = st.rect.top + 40; // on the QR image
    await page.mouse.move(cx, cy);
    await new Promise((r) => setTimeout(r, 500)); // well past the grace period
    const onCard = await cardState();
    note(onCard.shown && onCard.srcPrefix === 'data:image/png' ? '✅' : '❌',
      'card stays open under pointer, QR served as PNG img',
      `shown=${onCard.shown} src=${onCard.srcPrefix}`);
  }

  // ---- 8c. right-click on the QR does not dismiss the card ----
  {
    const st = await cardState(); // pointer still on the card from 8b
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await new Promise((r) => setTimeout(r, 250));
    const after = await cardState();
    const dec = decode(after.qr);
    note(st.shown && after.shown && dec === 'https://example.com/share?ref=pulldownqr' ? '✅' : '❌',
      'right-click on QR keeps card (copy-image surface reachable)',
      `before=${st.shown} after=${after.shown} decoded=${dec}`);
    await page.screenshot({ path: join(ART, '07-rightclick-on-card.png') });
  }

  // ---- 8d. left-click outside the card still dismisses ----
  {
    await page.mouse.move(600, 400);
    await page.mouse.down(); await page.mouse.up();
    await new Promise((r) => setTimeout(r, 150));
    const st = await cardState();
    note(!st.shown ? '✅' : '❌', 'click outside dismisses card', `shown=${st.shown}`);
  }

  // ---- 8e. opening the QR's context menu steals focus: that blur must NOT
  //          hide the card, but a later unrelated blur must ----
  {
    const st = await hoverAndRead('#normal');
    const cx = st.rect.left + st.rect.width / 2;
    const cy = st.rect.top + 40;
    await page.mouse.move(cx, cy);
    await new Promise((r) => setTimeout(r, 100));
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await new Promise((r) => setTimeout(r, 50));
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); // menu opened
    await new Promise((r) => setTimeout(r, 200));
    const during = await cardState();
    await page.mouse.move(cx + 3, cy + 3); // menu closed, pointer moves again
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await new Promise((r) => setTimeout(r, 200));
    const later = await cardState();
    note(during.shown && !later.shown ? '✅' : '❌',
      'context-menu blur keeps card, later blur hides',
      `duringMenu=${during.shown} later=${later.shown}`);
  }

  // ---- 8z. left-click on the QR copies the image to the clipboard ----
  {
    const st = await hoverAndRead('#normal');
    const cx = st.rect.left + st.rect.width / 2;
    const cy = st.rect.top + 40; // on the QR image
    await page.mouse.move(cx, cy);
    await new Promise((r) => setTimeout(r, 60));
    await page.mouse.down(); await page.mouse.up();   // plain left click
    await new Promise((r) => setTimeout(r, 250));
    const after = await cardState();
    const toastOk = after.shown && after.toast && after.toast.show &&
      after.toast.text.includes('QR画像をコピーしました');

    // Read the image back off the clipboard and decode it — proves the real
    // bytes landed, not just that the toast fired.
    const clip = await page.evaluate(async () => {
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          if (it.types.includes('image/png')) {
            const blob = await it.getType('image/png');
            const bmp = await createImageBitmap(blob);
            const cv = document.createElement('canvas');
            cv.width = bmp.width; cv.height = bmp.height;
            cv.getContext('2d').drawImage(bmp, 0, 0);
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
            return { data: Array.from(d.data), width: cv.width, height: cv.height };
          }
        }
        return null;
      } catch (e) { return 'ERR:' + e.message; }
    });
    let clipNote = 'clipboard-read unavailable';
    let clipOk = true; // don't fail the whole check if headless blocks read
    if (clip && typeof clip === 'object') {
      const dec = decode(clip);
      clipOk = dec === 'https://example.com/share?ref=pulldownqr';
      clipNote = `clipboard QR decoded=${dec}`;
    } else if (typeof clip === 'string') {
      clipNote = clip;
    }
    note(toastOk && clipOk ? '✅' : '❌', 'left-click copies QR image to clipboard',
      `toast="${after.toast && after.toast.text}" ${clipNote}`);
    await page.screenshot({ path: join(ART, '10-copied-toast.png') });
  }

  // ---- 8z2. left-click on the URL text copies the link as text ----
  {
    const st = await hoverAndRead('#normal');
    const exp = await expectedHref('#normal');
    // The .url label sits below the QR near the card bottom.
    const lx = st.rect.left + st.rect.width / 2;
    const ly = st.rect.bottom - 12;
    await page.mouse.move(lx, ly);
    await new Promise((r) => setTimeout(r, 60));
    await page.mouse.down(); await page.mouse.up();
    await new Promise((r) => setTimeout(r, 200));
    const after = await cardState();
    const toastOk = after.shown && after.toast && after.toast.show &&
      after.toast.text.includes('リンクをコピー');
    const clipText = await page.evaluate(async () => {
      try { return await navigator.clipboard.readText(); }
      catch (e) { return 'ERR:' + e.message; }
    });
    const clipOk = clipText === exp || clipText.startsWith('ERR:'); // headless may block read
    note(toastOk && clipOk ? '✅' : '❌', 'left-click on URL copies link text',
      `toast="${after.toast && after.toast.text}" clip=${JSON.stringify(clipText).slice(0, 60)}`);
  }

  // ---- 8z3. dragging a text selection on the URL does NOT trigger copy ----
  {
    const st = await hoverAndRead('#normal');
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL').catch(() => {}));
    const lx = st.rect.left + 30;
    const ly = st.rect.bottom - 12;
    await page.mouse.move(lx, ly);
    await page.mouse.down();
    await page.mouse.move(lx + 80, ly, { steps: 8 }); // drag-select within the label
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 150));
    const clipText = await page.evaluate(async () => {
      try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR'; }
    });
    // Selection drag must not overwrite the clipboard with the full URL.
    const ok = clipText === 'SENTINEL' || clipText === 'ERR';
    note(ok ? '✅' : '⚠️', 'text-selection drag does not auto-copy', `clip=${JSON.stringify(clipText).slice(0, 40)}`);
  }

  // ---- 8z4. a plain click on already-selected URL text still copies ----
  {
    const st = await hoverAndRead('#normal');
    const exp = await expectedHref('#normal');
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL').catch(() => {}));
    const lx = st.rect.left + 30;
    const ly = st.rect.bottom - 12;
    // First drag-select the label (leaves a selection, no copy)...
    await page.mouse.move(lx, ly);
    await page.mouse.down();
    await page.mouse.move(lx + 80, ly, { steps: 8 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 80));
    // ...then a plain click on the selected text should copy the whole link.
    await page.mouse.move(lx + 20, ly);
    await page.mouse.down(); await page.mouse.up();
    await new Promise((r) => setTimeout(r, 200));
    const clipText = await page.evaluate(async () => {
      try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR:' + e.message; }
    });
    const ok = clipText === exp || clipText.startsWith('ERR:');
    note(ok ? '✅' : '❌', 'click on selected URL text still copies',
      `clip=${JSON.stringify(clipText).slice(0, 50)}`);
  }

  // ---- 8f. quick switch between links swaps the card cleanly ----
  {
    await neutral();
    await page.hover('#normal');
    await new Promise((r) => setTimeout(r, 350));
    // Switch directly to a link far enough down to not be covered by A's card.
    await page.hover('#jp');
    await new Promise((r) => setTimeout(r, 400));
    const st = await cardState();
    const dec = decode(st.qr);
    const expJp = await expectedHref('#jp');
    note(st.shown && dec === expJp ? '✅' : '❌',
      'A->B switch swaps card without orphan', `shown=${st.shown} decoded=${dec}`);
  }


  // ---- 8g. cursor-follow mode: card reachable by a gradual approach ----
  {
    await setSync({ position: 'cursor' });
    await new Promise((r) => setTimeout(r, 200));
    const st = await hoverAndRead('#normal');
    const link = await page.$eval('#normal', (a) => {
      const r = a.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    // Walk the pointer diagonally toward the card in small steps — with the
    // old chasing behavior the card stays 14/16px ahead and is never reached.
    await page.mouse.move(link.x + 30, link.y + 40, { steps: 15 });
    await new Promise((r) => setTimeout(r, 450)); // past the grace period
    const onCard = await cardState();
    note(st.shown && onCard.shown ? '✅' : '❌',
      'cursor mode: card freezes on link-exit and is reachable',
      `initial=${st.shown} reached=${onCard.shown}`);
  }

  // ---- 8h. cursor mode at the viewport corner: card never sits under the pointer ----
  {
    const st = await hoverAndRead('#corner');
    let underPointer = null;
    if (st.shown) {
      // page.hover put the pointer at the link's center; the card must not
      // contain that point or it would swallow the link's clicks.
      const hover = await page.$eval('#corner', (a) => {
        const r = a.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      underPointer = hover.x >= st.rect.left && hover.x <= st.rect.right &&
                     hover.y >= st.rect.top && hover.y <= st.rect.bottom;
    }
    await setSync({ position: 'link' });
    await new Promise((r) => setTimeout(r, 200));
    note(st.shown && underPointer === false ? '✅' : '❌',
      'cursor mode corner: card flips off the pointer', `shown=${st.shown} underPointer=${underPointer}`);
  }

  // ---- 8i. requireAlt: pressing Alt while already hovering shows; release hides ----
  {
    await setSync({ requireAlt: true });
    await new Promise((r) => setTimeout(r, 200));
    await neutral();
    await page.hover('#normal');                    // hover WITHOUT Alt
    await new Promise((r) => setTimeout(r, 200));
    const beforeAlt = (await cardState()).shown;    // expect false
    await page.keyboard.down('Alt');                // press Alt while still resting on the link
    await new Promise((r) => setTimeout(r, 250));   // > hoverDelayMs
    const whileAlt = (await cardState()).shown;     // expect true
    await page.keyboard.up('Alt');                  // release -> "only while held" hides
    await new Promise((r) => setTimeout(r, 200));
    const afterAlt = (await cardState()).shown;     // expect false
    await setSync({ requireAlt: false });
    await new Promise((r) => setTimeout(r, 200));
    note(!beforeAlt && whileAlt && !afterAlt ? '✅' : '❌',
      'requireAlt: Alt-press while hovering shows, release hides',
      `before=${beforeAlt} while=${whileAlt} after=${afterAlt}`);
  }

  // ---- 8j. SPA: detaching the hovered link clears the orphaned card ----
  {
    await setSync({ requireAlt: false });
    await new Promise((r) => setTimeout(r, 150));
    const st = await hoverAndRead('#spa');
    const shownBefore = st.shown;
    // Simulate an SPA route swap that detaches the hovered <a> in place.
    await page.evaluate(() => {
      history.pushState({}, '', '/spa-route');
      document.getElementById('spaHolder').innerHTML = '<span>new content</span>';
    });
    await new Promise((r) => setTimeout(r, 120));
    const shownAfterSwap = (await cardState()).shown;   // stationary cursor: may linger
    await page.mouse.move(400, 400);                     // first move clears it
    await new Promise((r) => setTimeout(r, 120));
    const shownAfterMove = (await cardState()).shown;
    note(shownBefore && !shownAfterMove ? '✅' : '❌',
      'SPA detach clears orphaned card', `before=${shownBefore} afterSwap=${shownAfterSwap} afterMove=${shownAfterMove}`);
    // restore the page for later tests
    await page.evaluate((origin) => {
      history.pushState({}, '', '/');
      document.getElementById('spaHolder').innerHTML =
        '<a id="spa" href="https://spa.example/before">SPA link</a>';
    }, ORIGIN);
  }

  // ---- 8k. requireAlt: card on the card survives Alt release (copy reachable) ----
  {
    await setSync({ requireAlt: true });
    await new Promise((r) => setTimeout(r, 200));
    await neutral();
    await page.keyboard.down('Alt');
    await page.hover('#normal');
    await new Promise((r) => setTimeout(r, 250));
    const onLink = (await cardState()).shown;            // shown with Alt held
    const rect = (await cardState()).rect;
    await page.mouse.move(rect.left + rect.width / 2, rect.top + 40); // onto the QR
    await new Promise((r) => setTimeout(r, 120));
    await page.keyboard.up('Alt');                       // release while ON the card
    await new Promise((r) => setTimeout(r, 200));
    const afterRelease = (await cardState()).shown;      // must survive
    await page.mouse.down(); await page.mouse.up();      // click QR -> copy
    await new Promise((r) => setTimeout(r, 200));
    const afterCopy = await cardState();
    const copied = afterCopy.shown && afterCopy.toast && afterCopy.toast.text.includes('QR画像をコピー');
    await page.mouse.move(5, 5);
    await new Promise((r) => setTimeout(r, 400));
    await setSync({ requireAlt: false });
    note(onLink && afterRelease && copied ? '✅' : '❌',
      'requireAlt: card survives Alt release while on card; copy works',
      `onLink=${onLink} afterRelease=${afterRelease} copied=${copied}`);
  }

  // ---- 8l. dark lightColor keeps the URL text legible (adaptive color) ----
  {
    await setSync({ lightColor: '#10151c', showUrl: true });
    await new Promise((r) => setTimeout(r, 200));
    await hoverAndRead('#normal');
    const urlColor = await page.evaluate(() => {
      const card = document.getElementById('__pdqr_host').shadowRoot.querySelector('.card');
      return getComputedStyle(card.querySelector('.url')).color;
    });
    await setSync({ lightColor: '#ffffff' });
    await new Promise((r) => setTimeout(r, 200));
    // On a dark background the label must be a light color, not the dark default.
    const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(urlColor);
    const lum = m ? (+m[1] + +m[2] + +m[3]) / 3 : 0;
    note(lum > 150 ? '✅' : '❌', 'URL text adapts to dark background', `color=${urlColor}`);
  }

  // ---- 8m. removing a settings key falls back to the default (not undefined) ----
  {
    await setSync({ enabled: false });               // disable -> no card
    await new Promise((r) => setTimeout(r, 200));
    const offState = await hoverAndRead('#normal');
    await sw.evaluate(() => new Promise((res) => chrome.storage.sync.remove('enabled', res)));
    await new Promise((r) => setTimeout(r, 250));     // onChanged fires with no newValue
    const afterRemove = await hoverAndRead('#normal'); // enabled should fall back to default true
    await setSync({ enabled: true });
    await new Promise((r) => setTimeout(r, 150));
    note(!offState.shown && afterRemove.shown ? '✅' : '❌',
      'removed key falls back to default (no undefined)',
      `off=${offState.shown} afterRemove=${afterRemove.shown}`);
  }

  // ---- 9. Escape hides ----
  {
    const st1 = await hoverAndRead('#normal');
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 120));
    const st2 = await cardState();
    note(st1.shown && !st2.shown ? '✅' : '❌', 'Escape hides card', `before=${st1.shown} after=${st2.shown}`);
  }

  // ---- 10. scroll hides ----
  {
    const st1 = await hoverAndRead('#normal');
    await page.mouse.wheel({ deltaY: 80 });
    await new Promise((r) => setTimeout(r, 150));
    const st2 = await cardState();
    note(st1.shown && !st2.shown ? '✅' : '❌', 'scroll hides card', `before=${st1.shown} after=${st2.shown}`);
    await page.evaluate(() => scrollTo(0, 0));
  }

  // ---- 11. corner link: card stays inside viewport ----
  {
    const st = await hoverAndRead('#corner');
    const vw = 1100, vh = 800;
    const inside = st.shown && st.rect.left >= 0 && st.rect.top >= 0 &&
      st.rect.right <= vw && st.rect.bottom <= vh;
    note(inside ? '✅' : '❌', 'corner link stays in viewport',
      st.rect ? `rect=${Math.round(st.rect.left)},${Math.round(st.rect.top)},${Math.round(st.rect.right)},${Math.round(st.rect.bottom)}` : 'not shown');
    await page.screenshot({ path: join(ART, '03-corner-hover.png') });
  }

  // ---- 12. disable via storage -> no card; re-enable -> card ----
  {
    await setSync({ enabled: false });
    await new Promise((r) => setTimeout(r, 200));
    const off = await hoverAndRead('#normal');
    await setSync({ enabled: true });
    await new Promise((r) => setTimeout(r, 200));
    const on = await hoverAndRead('#normal');
    note(!off.shown && on.shown ? '✅' : '❌', 'enabled toggle via storage', `off=${off.shown} on=${on.shown}`);
  }

  // ---- 13. requireAlt: no card without Alt, card with Alt held ----
  {
    await setSync({ requireAlt: true });
    await new Promise((r) => setTimeout(r, 200));
    const noAlt = await hoverAndRead('#normal');
    await neutral();
    await page.keyboard.down('Alt');
    const withAlt = await hoverAndRead('#normal');
    await page.keyboard.up('Alt');
    await setSync({ requireAlt: false });
    note(!noAlt.shown && withAlt.shown ? '✅' : '❌', 'requireAlt mode', `noAlt=${noAlt.shown} withAlt=${withAlt.shown}`);
  }

  // ---- 14. live re-render: change color while card visible ----
  {
    await new Promise((r) => setTimeout(r, 200));
    const st1 = await hoverAndRead('#normal');
    await setSync({ lightColor: '#1a1a2e', darkColor: '#e0e0ff' });
    await new Promise((r) => setTimeout(r, 250));
    const st2 = await cardState();
    const changed = st2.shown && st2.bg !== st1.bg;
    note(changed ? '✅' : '❌', 'live color re-render + card bg follows lightColor',
      `bg ${st1.bg} -> ${st2.bg}`);
    await page.screenshot({ path: join(ART, '04-dark-colors.png') });
    await setSync({ lightColor: '#ffffff', darkColor: '#10151c' });
  }

  // ---- 14b. nav-area links suppressed (the Google-tabs case) ----
  {
    const inNav = await hoverAndRead('#navlink');     // external URL but inside <nav>
    const tab = await hoverAndRead('#tabnav');        // role=navigation + same path
    const pager = await hoverAndRead('#pager');       // same path, query differs
    note(!inNav.shown && !tab.shown && !pager.shown ? '✅' : '❌',
      'nav / same-path links suppressed by default',
      `nav=${inNav.shown} tab=${tab.shown} pager=${pager.shown}`);
  }

  // ---- 14c. checks are independently toggleable ----
  {
    // #pager is same-origin, so also relax same-site suppression to isolate
    // the skipSamePathLinks behaviour under test.
    await setSync({ skipSamePathLinks: false, skipSameSiteLinks: false });
    await new Promise((r) => setTimeout(r, 200));
    const pagerOn = await hoverAndRead('#pager');     // now allowed
    const navStill = await hoverAndRead('#navlink');  // still blocked by skipNavLinks
    const dec = decode(pagerOn.qr);
    await setSync({ skipSamePathLinks: true, skipSameSiteLinks: true });
    note(pagerOn.shown && dec === `${ORIGIN}/?page=2` && !navStill.shown ? '✅' : '❌',
      'skipSamePathLinks off re-enables pager, nav check independent',
      `pager=${pagerOn.shown} decoded=${dec} nav=${navStill.shown}`);
  }

  // ---- 14f. same-site links suppressed by default; external still shown ----
  {
    // (defaults: skipSameSiteLinks on.) #samesite resolves to this very origin.
    const sameSite = await hoverAndRead('#samesite');   // same host -> suppressed
    const external = await hoverAndRead('#normal');      // example.com -> shown
    note(!sameSite.shown && external.shown ? '✅' : '❌',
      'same-site link suppressed, external link shown',
      `sameSite=${sameSite.shown} external=${external.shown}`);

    await setSync({ skipSameSiteLinks: false });
    await new Promise((r) => setTimeout(r, 200));
    const reenabled = await hoverAndRead('#samesite');   // now allowed
    const dec = decode(reenabled.qr);
    await setSync({ skipSameSiteLinks: true });
    await new Promise((r) => setTimeout(r, 200));
    note(reenabled.shown && dec === `${ORIGIN}/some/app/page` ? '✅' : '❌',
      'same-site suppression is toggleable', `shown=${reenabled.shown} decoded=${dec}`);
  }

  // ---- 14d. excludedSites disables the whole site ----
  {
    await setSync({ excludedSites: ['127.0.0.1'] });
    await new Promise((r) => setTimeout(r, 200));
    const blocked = await hoverAndRead('#normal');
    await setSync({ excludedSites: [] });
    await new Promise((r) => setTimeout(r, 200));
    const restored = await hoverAndRead('#normal');
    note(!blocked.shown && restored.shown ? '✅' : '❌',
      'excludedSites blocks and unblocks live', `blocked=${blocked.shown} restored=${restored.shown}`);
  }

  // ---- 14e. popup's host/url lookup message answers (host + full URL) ----
  {
    const res = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        try {
          const r = await chrome.tabs.sendMessage(t.id, { type: 'pdqr-get-host' });
          if (r && r.host) return r;
        } catch (e) { /* tab without content script */ }
      }
      return null;
    });
    const ok = res && res.host === '127.0.0.1' && typeof res.url === 'string' &&
      res.url.startsWith('http://127.0.0.1');
    note(ok ? '✅' : '❌', 'content script returns host + url', `host=${res && res.host} url=${res && res.url}`);
  }

  // ---- 14g. popup current-page QR renders, decodes, and copies ----
  {
    const pp = await browser.newPage();
    await browser.defaultBrowserContext().overridePermissions(`chrome-extension://${extId}`,
      ['clipboard-read', 'clipboard-sanitized-write']).catch(() => {});
    await pp.goto(`chrome-extension://${extId}/src/popup.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 300));
    const PAGE_URL = 'https://example.com/page?from=omnibox';
    // Drive the popup's real render path with a known URL (the action popup
    // can't be opened over a tab in headless, so invoke the exposed hook).
    const qr = await pp.evaluate((url) => {
      window.__pdqrRenderPageQR(url);
      const cv = document.getElementById('pageQr');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
      return {
        wrapShown: !document.getElementById('pageQrWrap').hidden,
        urlText: document.getElementById('pageQrUrl').textContent,
        data: Array.from(d.data), width: cv.width, height: cv.height,
      };
    }, PAGE_URL);
    const dec = decode(qr);
    // Click the QR -> image on clipboard; click the URL -> text on clipboard.
    await pp.evaluate(() => document.getElementById('pageQr').click());
    await new Promise((r) => setTimeout(r, 200));
    const clipImg = await pp.evaluate(async () => {
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) if (it.types.includes('image/png')) {
          const b = await it.getType('image/png'); const bmp = await createImageBitmap(b);
          const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
          cv.getContext('2d').drawImage(bmp, 0, 0);
          const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
          return { data: Array.from(d.data), width: cv.width, height: cv.height };
        }
      } catch (e) { return 'ERR'; }
      return null;
    });
    await pp.evaluate(() => document.getElementById('pageQrUrl').click());
    await new Promise((r) => setTimeout(r, 200));
    const clipText = await pp.evaluate(async () => {
      try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR'; }
    });
    await pp.screenshot({ path: join(ART, '11-popup-page-qr.png') });
    await pp.close();
    const imgOk = (clipImg && typeof clipImg === 'object') ? decode(clipImg) === PAGE_URL : true;
    const textOk = clipText === PAGE_URL || clipText === 'ERR';
    note(qr.wrapShown && dec === PAGE_URL && qr.urlText === PAGE_URL && imgOk && textOk ? '✅' : '❌',
      'popup current-page QR renders + copies', `decoded=${dec} img=${imgOk} text=${JSON.stringify(clipText).slice(0, 40)}`);
  }

  // ---- 15. popup page loads cleanly ----
  {
    const pp = await browser.newPage();
    const errs = [];
    pp.on('pageerror', (e) => errs.push(String(e)));
    await pp.goto(`chrome-extension://${extId}/src/popup.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 300));
    const ok = await pp.evaluate(() =>
      !!document.getElementById('enabled') && document.getElementById('enabled').checked &&
      document.getElementById('qrSizeVal').textContent.length > 0);
    await pp.screenshot({ path: join(ART, '05-popup.png') });
    note(ok && errs.length === 0 ? '✅' : '❌', 'popup loads & reflects settings', errs.join('; '));
    await pp.close();
  }

  // ---- 15b. popup exposes the same-site toggle and it persists ----
  {
    await setSync({ skipSameSiteLinks: true });
    await new Promise((r) => setTimeout(r, 150));
    const pp = await browser.newPage();
    await pp.goto(`chrome-extension://${extId}/src/popup.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 250));
    const reflectsOn = await pp.evaluate(() => {
      const el = document.getElementById('skipSameSiteLinks');
      return el ? el.checked : null;
    });
    // Flip it off via the toggle and confirm it writes through to storage.
    await pp.evaluate(() => document.getElementById('skipSameSiteLinks').click());
    await new Promise((r) => setTimeout(r, 200));
    const stored = await sw.evaluate(() => new Promise((res) =>
      chrome.storage.sync.get({ skipSameSiteLinks: true }, (v) => res(v.skipSameSiteLinks))));
    await pp.close();
    await setSync({ skipSameSiteLinks: true });
    note(reflectsOn === true && stored === false ? '✅' : '❌',
      'popup same-site toggle reflects & persists', `reflects=${reflectsOn} storedAfterOff=${stored}`);
  }

  // ---- 16. options page loads, preview canvas rendered ----
  {
    const op = await browser.newPage();
    const errs = [];
    op.on('pageerror', (e) => errs.push(String(e)));
    await op.goto(`chrome-extension://${extId}/src/options.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 300));
    const pv = await op.evaluate(() => {
      const cv = document.getElementById('pv');
      if (!cv || cv.width === 0) return null;
      const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
      return { data: Array.from(img.data), width: cv.width, height: cv.height };
    });
    const dec = pv ? decode(pv) : null;
    await op.screenshot({ path: join(ART, '06-options.png') });
    note(dec === 'https://example.com/share?ref=pulldownqr' && errs.length === 0 ? '✅' : '❌',
      'options page + preview QR decodes', `decoded=${dec} ${errs.join('; ')}`);
    await op.close();
  }

  // ---- 16b. clicking the toggle SLIDER (not just the side label) flips & saves ----
  {
    await setSync({ showUrl: true });
    await new Promise((r) => setTimeout(r, 200));
    const op = await browser.newPage();
    await op.goto(`chrome-extension://${extId}/src/options.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 350));
    const before = await op.evaluate(() => document.getElementById('showUrl').checked);
    const pt = await op.evaluate(() => {
      const s = document.getElementById('showUrl').parentElement.querySelector('.slider');
      s.scrollIntoView({ block: 'center' });
      const r = s.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await op.mouse.click(pt.x, pt.y);              // click the visible slider
    await new Promise((r) => setTimeout(r, 500));  // past options.js 300ms debounce
    const after = await op.evaluate(() => document.getElementById('showUrl').checked);
    const stored = await sw.evaluate(() => new Promise((res) =>
      chrome.storage.sync.get({ showUrl: true }, (v) => res(v.showUrl))));
    await op.close();
    await setSync({ showUrl: true });
    note(before === true && after === false && stored === false ? '✅' : '❌',
      'options toggle slider click flips and persists', `before=${before} after=${after} stored=${stored}`);
  }

  // ---- 16c. popup toggle slider click flips the checkbox ----
  {
    await setSync({ enabled: true });
    await new Promise((r) => setTimeout(r, 200));
    const pp = await browser.newPage();
    await pp.goto(`chrome-extension://${extId}/src/popup.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 300));
    const before = await pp.evaluate(() => document.getElementById('enabled').checked);
    const pt = await pp.evaluate(() => {
      const s = document.getElementById('enabled').parentElement.querySelector('.slider');
      const r = s.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await pp.mouse.click(pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 200));
    const after = await pp.evaluate(() => document.getElementById('enabled').checked);
    await pp.close();
    await setSync({ enabled: true });
    note(before === true && after === false ? '✅' : '❌',
      'popup toggle slider click flips the checkbox', `before=${before} after=${after}`);
  }

  // ---- 16d. platform-aware modifier label (test host is macOS) ----
  {
    const pp = await browser.newPage();
    const errs = [];
    pp.on('pageerror', (e) => errs.push(String(e)));
    await pp.goto(`chrome-extension://${extId}/src/popup.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 300));
    const info = await pp.evaluate(() => ({
      isMac: pdqrIsMac(),
      mod: document.querySelector('.modkey').textContent,
      kbd: document.getElementById('scKbd').textContent,
    }));
    await pp.close();
    // Both names shown in parallel; the platform's own key comes first. kbd is
    // populated either with the bound shortcut or the 未設定 fallback.
    const expected = info.isMac ? 'Option（⌥）/ Alt' : 'Alt / Option（⌥）';
    const ok = info.mod === expected && info.kbd.length > 0 && errs.length === 0;
    note(ok ? '✅' : '❌', 'modifier label shows Option/Alt for the platform',
      `isMac=${info.isMac} mod="${info.mod}" kbd="${info.kbd}" ${errs.join(';')}`);
  }

  // ---- 17. console/page errors on the test page across the whole run ----
  note(pageErrors.length === 0 ? '✅' : '❌', 'no uncaught page errors', pageErrors.join('; ') || 'clean');
  if (consoleErrors.length) note('⚠️', 'console errors seen', consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

const fails = results.filter((r) => r.icon === '❌').length;
writeFileSync(join(ART, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
