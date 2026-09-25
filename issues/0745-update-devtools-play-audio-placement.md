# moqt-devtools の subscriber の Play Audio の行で、Catalog の位置が publisher とずれる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/update-devtools-play-audio-placement
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の subscriber は、音声のメーターと Catalog の間に Play Audio のボタンの行を置く。publisher にはこの行が無いため、横に並べた 2 つのパネルで Catalog 以降の位置がずれる。利用者から「Play Audio があるとカタログ位置が publisher / subscriber ずれるから、どっか据わりの良い場所に置いて」と要望があった。

## 現状

- `devtools/src/components/SubscriberPanel.tsx` は、映像の枠の下に音声のメーター (`AudioMeter`)、Play Audio のボタンと説明の行、Catalog (`CatalogTracks`)、統計の順に並べる
- `devtools/src/components/PublisherPanel.tsx` は、映像の枠の下に音声のメーター、Catalog、統計の順に並べる
- 映像の上の 1 行の項目の行 (`PANEL_OPTION_ROW_CLASS`) は両パネルで同じ高さで、publisher は Forward State、subscriber は NEW_GROUP_REQUEST の切り替えを置く

## 設計方針

- Play Audio を、subscriber の 1 行の項目の行 (NEW_GROUP_REQUEST と同じ行) に切り替え (checkbox) として置く。行の高さは publisher の Forward State の行と同じまま
- NEW_GROUP_REQUEST は購読中は変えられないが、Play Audio は購読中も切り替えられるままにする
- 既存の E2E (`tests/e2e/devtools-audio.spec.ts`) の再生の切り替えの確かめ方を、checkbox に合わせる

## 完了条件

- 横に並べた publisher と subscriber で、音声のメーターと Catalog の上端がそろう
- 受信した音声の再生を、今と同じく既定で無効にし、切り替えられる
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
