# アーキテクチャ詳細 — PullDown QR

実装の内部構造をまとめた開発者向けドキュメントです。利用者向けの説明は
[README.md](../README.md) を参照してください。

## 全体像

```
┌─────────────────────────────────────────────────────────────┐
│ Web ページ（最上位フレームのみ / all_frames: false）          │
│                                                               │
│  content.js（isolated world）                                 │
│   ├─ mouseover/out/move, keydown/up, scroll, click を監視     │
│   ├─ eligibleUrl() でリンクを取捨                              │
│   ├─ qrcode-generator で QR を計算                             │
│   └─ Shadow DOM のカードに <img>(data:image/png) で表示       │
│        └─ 左クリック: 画像コピー / URL クリック: リンクコピー   │
└───────────────▲───────────────────────────────────────────────┘
                │ chrome.storage.sync（設定）/ runtime message
┌───────────────┴───────────────┐   ┌──────────────────────────┐
│ background.js（Service Worker）│   │ popup / options（拡張ページ）│
│  既定値初期化・バッジ・commands │   │  設定UI・ライブプレビュー    │
└───────────────────────────────┘   └──────────────────────────┘
```

すべてのコンテキストが `defaults.js`（既定値・設定取得・プラットフォーム判定）を
共有します。`content.js` では manifest の `content_scripts.js` に
`vendor/qrcode-generator.js → qr-render.js → defaults.js → content.js` の順で並べることで、
同一 isolated world のグローバルとして `qrcode` と `PDQR_*` ヘルパを参照できます。

## 設定モデルと同期

- 既定値は `defaults.js` の `DEFAULTS` に集約。`pdqrGetSettings()` が
  `chrome.storage.sync.get(DEFAULTS, …)` で未設定キーを既定値で補完して返します。
- 書き込みは popup / options から `chrome.storage.sync.set(...)`。スライダーや
  テキストエリアは書き込み回数の制限（クォータ）を避けるため **デバウンス** しています。
- `content.js` は `chrome.storage.onChanged`（area: `sync`）を購読し、開いている
  全タブへ即時反映。カード表示中に色・サイズ等が変わった場合は再描画し、進行中の
  グレース（自動消去）タイマーがあれば再武装します。

## content.js のイベント状態機械

カードの表示は複数のタイマー・参照で管理されます。

- `currentAnchor` / `currentUrl` … いま表示中のカードが指すリンク
- `pendingAnchor` / `pendingUrl` … 表示予約済み（`showTimer` 発火前）のリンク
- `hoveredAnchor` / `hoveredUrl` … **カーソル直下の対象リンク**（表示の有無に関係なく追跡）
- `showTimer` … `hoverDelayMs` 後に `show()` を呼ぶ
- `hideTimer` … `HIDE_GRACE_MS`(=250ms) 後に `hide()` を呼ぶ猶予

主な流れ:

1. `mouseover` → `findAnchor()` で最寄りの `a[href]` を取得 → 抑制チェック →
   `eligibleUrl()` → `hovered*` を更新し `scheduleShow(anchor, url, e.altKey)`。
2. `scheduleShow()`
   - 同じリンクで既に表示中なら維持（`hideTimer` をキャンセル）。
   - `requireAlt` かつ Alt 未押下なら何もしない（ただし `hovered*` は追跡済み）。
   - 別リンクへ移る場合は旧カードを **即時消去せずグレースで** 消す（ポインタが
     カードへ移動中の取りこぼしを防ぐ）。
3. `show()` → `renderQR()` 成功時のみカードを表示。失敗時は `hide()`（旧カードを残さない）。
4. 退出系: `mouseout`（リンクを離れたらグレース起動）/ `scroll` / `wheel` /
   `mousedown`（カード外）/ `Esc` / `blur` / `visibilitychange` で消去。

### 「ポインタ追従」モードの凍結

`position: 'cursor'` ではカードがカーソルを追います。ただし **カードの上に乗った／
リンクを離れた（`hideTimer` 武装中）** ときは追従を止めます。追い続けるとカードが
ポインタから逃げ、右クリックやコピーができなくなるためです。`positionCard()` は
ビューポート内にクランプし、カードがポインタ直下に来る場合は反対側へ反転させます。

### Option（⌥）/ Alt の扱い

- `requireAlt` モードでは、表示の発火条件に Alt（Mac は Option＝DOM 上 `altKey`）を要求。
- `keydown`（`e.key === 'Alt'`）: ホバー中（`hoveredAnchor` あり）かつ未表示なら
  `scheduleShow(…, true)` で表示。**ホバーし直さずキー押下だけで出せます。**
- `keyup`（`e.key === 'Alt'`）: 「押している間だけ表示」の語義どおり `hide()`。

## URL 取捨（eligibleUrl）と抑制

`eligibleUrl(anchor)` は次の順で判定します。

1. `href` を文字列化（HTML は string、SVG の `<a>` は `SVGAnimatedString` なので
   `baseVal` / `getAttribute('href')` を併用）し、`new URL(raw, location.href)` で絶対化。
2. `SKIP_SCHEMES`（`javascript:` `about:` `blob:` `data:`）を除外。
3. 2048文字超を除外。
4. **同一サイト**（`skipSameSiteLinks`, 既定オン）の場合は除外。判定は共有ヘルパ
   `pdqrSameSite(linkHost, pageHost)`＝「同一ホスト、またはどちらかが他方のサブドメイン」
   （`a===b || a.endsWith('.'+b) || b.endsWith('.'+a)`）。Public Suffix List を使わないため
   `a.github.io` と `b.github.io` は別サイト扱い。`mailto:`/`tel:` はホストが空なので非該当。
   QRは「別の場所で開く」用途が主なので、既定で外部リンクのみを対象にする狙い。
5. 現在ページと **オリジン＋パスが同じ** 場合:
   - `skipSamePathLinks` がオンならクエリ違いも含めて除外（検索タブ・ページャ等）。
   - オフでも、クエリも同じで `#フラグメント` だけ違うものは除外。

加えて `mouseover` 側で:

- `skipNavLinks` がオンなら `nav,[role="navigation"],[role="tablist"],[role="tab"],
  [role="menubar"],[role="menu"]` の内側を除外。
- `excludedSites` に一致するホスト（`*.` 前置やサブドメイン一致対応）では完全に無効
  （`recomputeSiteBlocked()` が `siteBlocked` を更新）。

## QR の描画

描画は共通モジュール **`src/qr-render.js` の `pdqrDrawQR(canvas, text, opts)`** に集約され、
content / popup / options の3者が同じ実装を使います（`opts = {ecc, margin, target, darkColor, lightColor}`、
戻り値は描画したCSSピクセル辺長、失敗時 0）。

- `qrcode(0, level)` で自動バージョン選択。`ecc` で収まらない場合は `M → L` の順に段階的に
  フォールバック（`[ecc, 'M', 'L']` から重複を除いた順）。
- モジュール数＋`margin`（クワイエットゾーン、既定4）から整数セルサイズを算出し、
  `devicePixelRatio` 倍のビットマップに塗りつつ、`canvas.style` のCSSサイズも設定。
- 非ASCII対応のため、`qrcode.stringToBytes` を UTF-8 実装へ差し替える処理もこのモジュールで一度だけ行う。

content.js の `renderQR(text)` はこれを呼び、`canvas.toDataURL('image/png')` を
**表示用 `<img>` の `src`** に設定（ブラウザ標準の右クリック「画像をコピー / 保存」とドラッグが
そのまま使える）。URL ラベルの幅を QR と同じに固定し、カードが URL 文字列で横に広がらないように
します（カードは `width: max-content` + flex 中央寄せで QR 幅にフィット）。

## コピー機能

- **QR画像（左クリック）**: `new ClipboardItem({ 'image/png': Promise<Blob> })` を
  `navigator.clipboard.write()` に渡します。Promise を渡すことで `canvas.toBlob` の
  非同期処理をクリックのユーザー操作（ユーザーアクティベーション）に紐付けられます。
- **リンク（URLクリック）**: `navigator.clipboard.writeText(currentUrl)`。
  ドラッグでテキスト選択した場合はコピーしないよう、`mousedown→click` の **移動量**
  （6px超ならドラッグ）で判別します。選択状態に依存しないため、選択済みテキストを
  クリックしても確実にコピーできます。
- 結果は Shadow DOM 内の下部ピル型 **トースト**（`flashToast`, 約1.1秒）で通知。
- 失敗時（例: `Permissions-Policy: clipboard-write=()` のサイト）は「右クリックで保存」を案内。

### カードの操作性とネイティブメニュー

カードは表示中のみ `pointer-events: auto`。右クリックでネイティブの
コンテキストメニューが開くとウィンドウが `blur` するため、直近の右クリックを
記録（`nativeMenuAt`）し、**その blur を一度だけ無視** して誤消去を防ぎます。
通常のタブ/アプリ切替の blur は従来どおり消去します。

## Service Worker（background.js）

- `onInstalled`: 既定値で不足キーを補完（既存値は保持）。
- ツールバーバッジ: 無効時に `off` 表示。`storage.onChanged` で同期。
- `commands.onCommand('toggle-enabled')`: `enabled` を反転（ショートカット）。
- `defaults.js` は `importScripts('defaults.js')` で読み込みます。

## アイコン生成（tools/gen-icons.mjs）

外部依存なしで PNG を生成します。

- **PNGエンコーダを自前実装**: シグネチャ＋`IHDR`/`IDAT`（`node:zlib` の `deflateSync`）/
  `IEND` を組み立て、各チャンクの CRC32 を計算（8bit RGBA・フィルタ0）。
- **描画**: RGBA バッファへ矩形を塗る関数で、角3か所のファインダパターン
  （外枠＝青 → 中抜き＝透明 → 中心＝青の同心四角）と、右下の 3×3 データ風チェッカーを描画。
- 色は `rgb(37,99,235)`、背景は透過。サイズは比率（余白9%・ファインダ42%）で算出し、
  16/32/48/128px を出力。

詳しくは README の「[アイコンについて](../README.md#アイコンについて)」も参照。

## テスト（test/run-verify.mjs）

- Puppeteer（Chrome for Testing）に `--load-extension` で本拡張を読み込み、
  ローカル HTTP サーバのテストページで実際にホバー/クリック/キー操作を行います。
- 表示された QR は Shadow DOM 内 `<img>` を canvas に描き直して **jsQR でデコード** し、
  期待 URL と一致するかまで検証します（クリップボードは読み戻して照合）。
- クリップボード読み取りのため `overridePermissions` で
  `clipboard-read` / `clipboard-sanitized-write` を付与。
- 実行: `cd test && npm install && node run-verify.mjs`（出力は `test/artifacts/`）。

カバー範囲の例: 表示/非表示、ネスト/SVG/日本語/長大URL、画像・リンクのコピー（読み戻し）、
ドラッグ選択でコピーしないこと、抑制（同一パス・nav）、除外サイト、設定トグルの動作と保存、
Option/Alt の表記とホバー中のキー操作、カードのレイアウト（中央寄せ・QR幅フィット）。
