# moqt-devtools の画面で、状態によって項目が出たり消えたりして、映像や下の項目の位置が動く

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/update-devtools-fixed-layout-items
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の画面では、配信や購読の状態によって項目が現れたり、行が増えたりする。映像より上の項目が増えると映像が動き、下の項目が増えると、それより下の項目や (画面の幅が狭く Publisher の下に Subscriber が並ぶときは) Subscriber の映像が動く。利用者から「Forward State: 1 (forwarding) も publish したタイミングで増えるから映像が動いてしまう。単純に使いづらい」と報告があった。状態で出たり消えたりする項目を固定項目にし、値が無い間は「-」を出す。

## 現状

映像より上 (そのパネルの映像が動く):

- `devtools/src/components/PublisherPanel.tsx` の Forward State の行は、`pub.forwardState.value !== null` (配信を始めた後) のときだけ描く
- 両パネルの状態のメッセージ (`getStatusClasses()` の行) は折り返すため、長い文言 (例: `Disconnected: closeCode=..., reason=...`、`Failed: failed to get catalog: ...`) で 2 行以上になる

映像より下:

- `PublisherPanel.tsx` と `SubscriberPanel.tsx` の Catalog の欄は、catalog が届いた後 (`tracks.length > 0`) だけ描く。Track の数で高さも変わる
- `SubscriberPanel.tsx` の音声のレベルメーター (`AudioMeter`) は、音声トラックを購読している間 (`instance.audioSubscriber.value !== null`) だけ描く
- `devtools/src/components` の `EventLog` (recentStalls / subgroupStreamResetsByCode / recentLossEvents) は、件数に応じて `max-h-48` まで伸びる

## 設計方針

- 上の項目はすべて常に描き、値が無い間は「-」を出す
- Forward State の行は配信していない間も描き、値を「-」にする
- 状態のメッセージは 1 行に固定し、はみ出す分は省略して、`title` で全文を出す
- Catalog の欄は常に描き、Track の一覧の領域の高さを固定する (収まらない分は欄の中でスクロールする)。catalog が無い間は「-」を出す
- 音声のレベルメーターは常に描き、購読していない間は各値を「-」にし、波形は空にする
- `EventLog` の本文の高さを固定する (`max-h-48` を固定の高さにする)

## 完了条件

- Playwright の E2E で、配信の前後と購読の前後で、Publisher と Subscriber の映像の枠の上端の位置と、各パネルの高さが変わらないことを確かめる (実リレーを起動しないテストでは、配信の前の状態で各項目が描かれていることを確かめる)
- 音声のレベルメーターの E2E (`tests/e2e/devtools-audio-meter.spec.ts`) の「購読していないときはメーターを描画しない」を、「購読していないときは値を「-」にして描く」に直す
- `vp check` / `tsc --noEmit` / `vp test run` / Playwright の E2E が通る
