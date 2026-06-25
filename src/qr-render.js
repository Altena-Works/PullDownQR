// PullDown QR — shared QR canvas renderer.
// Loaded wherever a QR is drawn: the content script, the popup, and the options
// page. Centralises the encode + canvas-draw logic so the three callers stay in
// sync. Requires the qrcode-generator library to be loaded first.
(function () {
  'use strict';

  // Encode non-ASCII text as UTF-8 so international URLs/text round-trip.
  try {
    if (typeof qrcode === 'function' && qrcode.stringToBytesFuncs &&
        qrcode.stringToBytesFuncs['UTF-8']) {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
    }
  } catch (e) { /* ignore */ }

  // Draw `text` as a QR onto `canvas`, scaled for the device pixel ratio.
  // Returns the CSS-pixel side length drawn, or 0 if the text can't be encoded.
  // opts: { ecc:'L'|'M'|'Q'|'H', margin:int, target:px, darkColor, lightColor }.
  globalThis.pdqrDrawQR = function (canvas, text, opts) {
    opts = opts || {};
    const margin = Math.max(0, opts.margin | 0);
    const target = Math.max(80, (opts.target | 0) || 184);
    const dark = opts.darkColor || '#000000';
    const light = opts.lightColor || '#ffffff';

    // Try the requested ECC level, then step down so long inputs still fit.
    const levels = [opts.ecc || 'M', 'M', 'L'].filter((v, i, a) => a.indexOf(v) === i);
    let qr = null;
    for (const level of levels) {
      try {
        const q = qrcode(0, level);
        q.addData(text);
        q.make();
        qr = q;
        break;
      } catch (e) { /* data too large for this level — try a lower one */ }
    }
    if (!qr) return 0;

    const count = qr.getModuleCount();
    const total = count + margin * 2;
    const cell = Math.max(1, Math.floor(target / total));
    const size = cell * total;
    const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));

    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';   // CSS size (the bitmap is dpr× larger)
    canvas.style.height = size + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = dark;
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
      }
    }
    return size;
  };
})();
