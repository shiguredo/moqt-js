# moqt-devtools の画面が、横幅の狭い画面で横にはみ出す

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-narrow-width-overflow
- Polished: 2026-11-14
- Refreshed: 2026-11-14

## 目的

moqt-devtools を横幅の狭い画面 (スマートフォンの 390 px) で開くと、ページが画面の幅に収まらず、横にスクロールしないと見出しや接続設定の右側が見えない。

## 現状

- 実測 (2026-11-14、develop と配備の moqt-devtools、Chromium、横幅 390 px): `document.documentElement.scrollWidth` が 516 px になる (2026-09-25 の実測は 574 px)。ページの内容の入れ物 (`devtools/src/App.tsx` の `div.flex-1 bg-slate-100 min-h-screen ...`) と、その中の `div.max-w-7xl mx-auto px-4 py-6` が 516 px に広がる。外側の `div.flex min-h-screen bg-slate-100` は 390 px のまま
- 画面の右にはみ出していた要素は、見出しの下の説明の文、ヘッダーの DevTools リンク (現在は C4M DevTools / WebCodecs DevTools / WebTransport DevTools の 3 つ)、Connection Settings のヘルプのボタン (MOQT / LOC / MSF / C4M)、MOQT URI のラベルと入力など
- 入れ物を広げているのは、外側の flex の子 (`div.flex-1 ...`) の `min-width: auto`。内容の最小幅 516 px まで広がる。最小幅を決めているのは Connection Settings の見出し行 (`h2` の「Connection Settings」のボタンと MOQT / LOC / MSF / C4M のヘルプのボタンで 444 px、カードの余白 40 px と `div.max-w-7xl` の余白 32 px を足して 516 px)。`min-width: 0` にするとページの `scrollWidth` は 453 px まで下がるが、Publisher のボタンの行 (Preview / Publish / Stop mode / Stop) が 453 px、Subscriber の Start / Stop の行が 404 px まで広がるため、これらも 390 px に収める必要がある
- 390 px に収めると、Connection Settings の見出し行で「Connection Settings」の文字がヘルプのボタンに重なる (見出しのボタンは 40 px まで縮み、文字は 114 px のまま)。現状の 516 px のページでも、Subscriber の項目の行 (SUBSCRIBE / SUBSCRIBE_TRACKS / REQUEST_UPDATE) は `truncate` で右側が切れている (行の `scrollWidth` は 565 px、`clientWidth` は 444 px)。`min-width: 0` の後は `clientWidth` が 318 px になり、REQUEST_UPDATE のボタンが見えなくなる。ページの `scrollWidth` には現れない

## 設計方針

- 特定した要素 (外側の flex の子の最小幅、Connection Settings の見出し行、Publisher と Subscriber のボタン・項目の行) を、390 px で収まるようにする
- 横幅 390 px で、ページが画面の幅に収まり、横にスクロールしないようにする

## 完了条件

- 横幅 390 px で `document.documentElement.scrollWidth` が 390 px になる
- 横幅 390 px で、Connection Settings の見出しとヘルプのボタン、Publisher と Subscriber の操作行が重なったり切れたりせずに読める
- 横幅 1440 px の見た目は変わらない
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
