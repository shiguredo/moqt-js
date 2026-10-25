# devtools とライブラリで二重実装になっている受信・再生の経路をライブラリへ寄せる

- Created: 2026-10-09
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-share-playout-paths
- Polished: 2026-10-26
- Reporter: @voluntas

## 目的

moqt-devtools とライブラリで、受信した Object を復号して再生するまでの組み立てが 2 実装になっている。到着基準の遅れ、jitter buffer の目標、Group の切り替えの保留、計器への記録といった同じ修正を常に 2 か所へ入れなければならず、片方だけを直すと devtools とライブラリで挙動がずれる。devtools は検証に使う道具であり、ずれると「devtools で確かめた挙動」がライブラリの挙動ではなくなる。受信・再生の経路をライブラリ側の共有実装へ徹底的に寄せ、1 実装にする。

## 現状

- ライブラリ `src/createMediaSubscriber.ts` と devtools `devtools/src/hooks/useSubscriber.ts` は、catalog の購読、音声と映像の購読、購読の世代管理、停止、ログをそれぞれ持つ。復号の出力を受ける入口と再生の組み立ては、第 1 段と第 2 段で共有実装へ移した
- 第 1 段として音声の再生の組み立てを `src/playout/audioPlayoutSession.ts` の `AudioPlayoutSession` へ寄せた (コミット `d41b8a4`〜`7fabe4c`)
  - `createMediaSubscriber` の `handleAudioDecodedData` と `useSubscriber` の `handleAudioDecoded` は、再生の組み立てを `src/playout/mediaPlayout.ts` の `MediaPlayout` に任せる
  - 呼び出し側の 2 ファイルで 387 行減った (追加 117 行・削除 504 行)
- 第 2 段として映像の表示の組み立てを `src/playout/videoPlayoutSession.ts` の `VideoPlayoutSession` へ寄せた
  - `createMediaSubscriber` と `useSubscriber` はどちらも `MediaPlayout` を使い、映像側の自前の組み立てを持たない
  - `VideoDecodeInputs` は復号へ渡した TIMESTAMP の種類と位置を保持し、`MediaPlayout.trackVideoDecodeInput` から記録する
  - `VideoDecodeOrder` / `GroupSwitchGate` / `CatchUpGate` は `src/index.ts` から公開し、devtools は `moqt-js` から import する
  - `CatchUpGate` は `src/catchUpGate.ts` にあり、devtools の `devtools/src/utils/catchUpGate.ts` は無い
- devtools の `useSubscriber.ts` に残る `../../../src/...` の相対 import は 5 本の import 文であり、いずれも組み立てではなく、純関数とデコーダのラッパー (`AudioDecoderWrapper`) の参照である。映像と共有実装の組み立てに必要な相対 import は残っていない
- 購読そのもの (catalog の購読、音声と映像の購読、世代管理、停止、ログ) はまだ 2 実装である
  - ライブラリは `MediaSubscriberImpl.start` と `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription` を持つ
  - devtools は `useSubscriber.ts` の `startSubscribing` / `startAudioSubscription` / `startEventSubscription` / `closeSubscriberResources` / `teardownSubscriber` を持つ
- devtools の音声 Object の経路はまだ devtools 側にある。`useSubscriber.ts` の `handleAudioObject` が追いつきの判定と AAC の `AudioSpecificConfig` の適用を行い、`handleAudioDecoded` が `summarizeAudioLevel` でレベルの可視化を行う。追いつきの判定そのものは `src/catchUpGate.ts` の `CatchUpGate` を共有するが、選別の判断は devtools に残る
- 音声の閉ループは `MediaPlayout` の `AudioPlayoutSession` が音声を鳴らすたびに観測し、`PlayoutTimeline.observeAudioPlayout` で目標を更新する。`AudioPlayoutSessionOptions.audioDelayFeedback` は無く、`AvSyncStats.delays.audioDelayFeedback` に値が出る。実リレーの E2E (`tests/e2e/relay/devtools-both-audio.spec.ts`) はこの値をログへ出す
- `tests/e2e/relay/audio-timestamp.spec.ts` の後始末は、Debug パネルを閉じてから停止ボタンを押す形へ直した (コミット `00e4cbb7` / `958fe7c5`)。パネルが本文を狭めて停止ボタンの位置が動くことと、固定表示に覆われることを避ける

## 設計方針

第 1 段と第 2 段で確立した方針 (ブラウザ依存の注入、共有実装への移設、devtools 固有の判断を呼び出し側に残す) を第 3 段と第 4 段にも適用する。共有実装は「時間軸への記録・目標の決定・`PlayoutBuffer` の扱い・計器への記録」を持つ。挙動は変えず、移設と共有化だけを行う。devtools 固有の判断 (relay の cache から追いつく途中の Object を再生しない、購読ごとの統計と画面への反映) は呼び出し側に残す。

### 第 1 段: 音声の再生の組み立て (完了済み)

- `src/playout/audioPlayoutSession.ts` の `AudioPlayoutSession` が、復号した音声の時間軸への記録、目標の開始時刻の決定、`AudioPlayoutScheduler` への予約、計器 (`src/playout/audioPlayoutTimingStats.ts`) への記録を行う
- ライブラリと devtools の両方が `src/playout/mediaPlayout.ts` の `MediaPlayout` を使う。ブラウザ依存は `MediaPlayoutAudioOptions` の `context` と `destination`、または `MediaPlayout.setAudioOutput` で注入する
- 呼び出し側の 2 ファイルで 387 行減った (追加 117 行・削除 504 行)
- 公開 API は `createMediaPlayout` と `MediaPlayout` であり、`AudioPlayoutSession` は内部実装である。`docs/HIGH_LEVEL_API.md` に記載済み。`CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」により `CHANGES.md` は更新しない

### 第 2 段: 映像の再生の経路 (完了済み)

- `src/playout/videoPlayoutSession.ts` が `VideoPlayoutSession` と `VideoDecodeInputs` を持ち、`VideoPlayoutSession` が共有の時間軸への記録、`PlayoutBuffer` への積み方とあふれの処理、表示の drain、表示の実績の記録、捨てたフレームの計器への記録を行う。`VideoDecodeInputs` は `MediaPlayout` が保持し、`MediaPlayout.trackVideoDecodeInput` から記録する
- `src/createMediaSubscriber.ts` と `devtools/src/hooks/useSubscriber.ts` の両方から映像側の自前の組み立てを削除し、`MediaPlayout` を使う
- `VideoDecodeOrder` / `GroupSwitchGate` / `CatchUpGate` は `src/index.ts` から公開し、devtools は `moqt-js` から import する。`PlayoutBuffer` / `PlayoutTimeline` は `MediaPlayout` の内部で扱う
- `CatchUpGate` は `src/catchUpGate.ts` に移し、公開 API から使う
- 公開 API は `createMediaPlayout` と `MediaPlayout` であり、`VideoPlayoutSession` は内部実装である。`docs/HIGH_LEVEL_API.md` に記載済み。`CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」により `CHANGES.md` は更新しない
- 挙動は変えない。devtools の統計、パネル、「Copy for LLM」の項目と `data-testid` を欠けさせない

### 第 3 段: 購読そのもの

- catalog の購読、音声と映像の購読、購読の世代管理、停止、ログをライブラリの共有実装へ寄せる
- devtools 側には、購読の進行を画面へ出すための signal への反映だけを残す

### 第 4 段: devtools の音声 Object の経路

- devtools の音声 Object の追いつきの判定、音声レベルの可視化、AAC の `AudioSpecificConfig` の適用を共有実装へ寄せる
- 追いつきの判定は `src/catchUpGate.ts` の `CatchUpGate` を共有済みである。残るのは選別の判断、レベルの可視化、`AudioSpecificConfig` の適用である
- これで devtools 側から、音声の組み立てに関する `../../../src/...` の相対 import が無くなる

### 併せて行うこと (完了済み)

- devtools の音声の閉ループは `MediaPlayout` への移行で有効になっている。`AvSyncStats.delays.audioDelayFeedback` は実リレーの E2E のログで実測できる
- `tests/e2e/relay/audio-timestamp.spec.ts` の後始末は、Debug パネルを閉じてから停止ボタンを押す形へ直した (コミット `00e4cbb7` / `958fe7c5`)。タイムアウトは伸ばしていない

## 完了条件

- devtools とライブラリの受信・再生の経路が 1 実装になり、devtools 側に共有実装の組み立てを重複させる `../../../src/...` の相対 import が残っていない。純関数の参照は残ってよい
- `vp check` / `tsc --noEmit` / `vp test` / Playwright (chromium・relay) が通る
- 挙動が変わっていない。既存の統計値 (受信・復号・再生・同期の各項目) と E2E の `data-testid` が同じである
- devtools の閉ループの有効化は、`AvSyncStats.delays.audioDelayFeedback` の実測を伴う
