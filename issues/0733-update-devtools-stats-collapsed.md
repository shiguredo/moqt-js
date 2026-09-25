# moqt-devtools の統計の欄が常に開いていて、画面が長く見づらい

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/update-devtools-stats-collapsed
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の Publisher と Subscriber のパネルは、映像の下に統計の欄 (Encoding Pipeline、Latency Breakdown、Playback Timing、Stall Causes、Loss など) を常に開いて並べている。欄が多く画面が長くなり、映像と操作を見るだけのときに邪魔になる。利用者から「統計情報系はデフォルト閉じて、開くボタンを用意しよう。collapse っぽいしくみ」と要望があった。開け閉めの単位はパネルごとに 1 つにする (利用者と決めた)。

## 現状

- `devtools/src/components/PublisherPanel.tsx` と `SubscriberPanel.tsx` は、統計の欄 (`StatSection`) をパネルの下部に常に描く
- Playwright の E2E (`tests/e2e/devtools-stats-help.spec.ts`、`devtools-latency-breakdown.spec.ts`、`devtools-new-group-request.spec.ts` など) は、統計の欄が見えている前提で (?) のボタンや値を操作する
- sora-moq の相互運用 harness は統計を `window.moqtDevTools` から読むため、画面の開け閉めに依らない

## 設計方針

- 各パネルの統計の欄の上に「Statistics」の開け閉めのボタンを 1 つ置き、既定で閉じる。開くと統計の欄をすべて出す
- 閉じている間は統計の欄を描かない (`hidden` で隠すのではなく DOM に置かない)。値の計算と `window.moqtDevTools` の統計は開け閉めに依らない
- 開け閉めの状態はパネルごとに持ち、ページを読み込み直すと閉じた状態に戻る
- 開け閉めのボタンは `aria-expanded` を持ち、閉じた状態と開いた状態を ▸ / ▾ で示す

## 完了条件

- Playwright の E2E で、既定では統計の欄が描かれず、「Statistics」を押すと描かれ、もう一度押すと閉じることを、Publisher と Subscriber のそれぞれで確かめる
- 統計の欄を操作する既存の E2E は、先に「Statistics」を開いてから操作する形に直す
- `vp check` / `tsc --noEmit` / `vp test run` / Playwright の E2E が通る
