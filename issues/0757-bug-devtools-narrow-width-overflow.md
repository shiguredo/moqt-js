# moqt-devtools の画面が、横幅の狭い画面で横にはみ出す

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-narrow-width-overflow
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools を横幅の狭い画面 (スマートフォンの 390 px) で開くと、ページが画面の幅に収まらず、横にスクロールしないと見出しや接続設定の右側が見えない。

## 現状

- 実測 (2026-09-25、配備の moqt-devtools、Chromium、横幅 390 px): `document.documentElement.scrollWidth` が 574 px になる。ページ全体の入れ物 (`devtools/src/App.tsx` の `div.flex-1 bg-slate-100 min-h-screen ...`) と、その中の `div.max-w-7xl mx-auto px-4 py-6` が 574 px に広がる
- 画面の右にはみ出していた要素は、見出しの下の説明の文、WebCodecs DevTools / WebTransport DevTools のリンク、Connection Settings のヘルプのボタン (LOC)、Server URL のラベルと入力など
- どの要素が入れ物を広げているかはまだ特定していない

## 設計方針

- 入れ物を広げている要素を特定する (flex の子の最小の幅、折り返さない文、固定の幅など)
- 横幅 390 px で、ページが画面の幅に収まり、横にスクロールしないようにする

## 完了条件

- 横幅 390 px で `scrollWidth` が画面の幅と同じになる
- 横幅 1440 px の見た目は変わらない
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
