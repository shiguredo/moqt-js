# devtools とライブラリで二重実装になっている受信・再生の経路をライブラリへ寄せる

- Created: 2026-10-09
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-share-playout-paths
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools とライブラリで、受信した Object を復号して再生するまでの組み立てが 2 実装になっている。到着基準の遅れ、jitter buffer の目標、Group の切り替えの保留、計器への記録といった同じ修正を常に 2 か所へ入れなければならず、片方だけを直すと devtools とライブラリで挙動がずれる。devtools は検証に使う道具であり、ずれると「devtools で確かめた挙動」がライブラリの挙動ではなくなる。受信・再生の経路をライブラリ側の共有実装へ徹底的に寄せ、1 実装にする。

## 現状

- ライブラリ `src/createMediaSubscriber.ts` と devtools `devtools/src/hooks/useSubscriber.ts` が、それぞれ catalog の購読、音声と映像の購読、復号、再生までの組み立てを持つ
- 第 1 段として音声の再生の組み立てを `src/audioPlayoutSession.ts` の `AudioPlayoutSession` へ寄せた (コミット `d41b8a4`〜`7fabe4c`)。`createMediaSubscriber` の `handleAudioDecodedData` と `useSubscriber` の `handleAudioDecoded` は共有実装を呼ぶだけになり、呼び出し側の 2 ファイルで 387 行減った (追加 117 行・削除 504 行)
- 映像はまだ 2 実装である
  - 復号へ渡したフレームの情報 (TIMESTAMP の種類と Object の位置) を、ライブラリは `videoTimestampKinds`、devtools は `videoDecodeInputsRef` の `Map<number, DecodeInput>` と `rememberDecodeInput` が持つ。覚える上限も別々である
  - 表示待ちのキュー (`PlayoutBuffer`) の積み方、あふれた分の処理、表示の drain を、ライブラリは `handleVideoDecodedData` / `scheduleVideoFrameDrain` / `writeDueVideoFrames` / `writeVideoFrame` / `clearVideoPlayout`、devtools は `presentFrame` / `scheduleFrameDrain` / `drawFrame` / `clearPendingFrame` が持つ
  - `VideoDecodeOrder` (`src/videoDecodeOrder.ts`) と `GroupSwitchGate` (`src/groupSwitchGate.ts`) はライブラリのモジュールだが、devtools は `../../../src/...` の相対 import で直接組み立てる。devtools の `useSubscriber.ts` だけで、ライブラリ内部への相対 import が 11 本ある
  - relay の cache から追いつく途中の判定 (`CatchUpGate`) は devtools の `devtools/src/utils/catchUpGate.ts` にあり、ライブラリ側からは使えない。内部で `../../../src/session/params.ts` の `compareLocations` を相対 import している
  - 購読そのもの (catalog の購読、音声と映像の購読、世代管理、停止、ログ) も 2 実装である
  - devtools の音声 Object の経路 (追いつきの判定、レベルの可視化、AAC の config の適用) も devtools 側にある
- 第 1 段で、devtools の音声の閉ループは `AudioPlayoutSessionOptions.audioDelayFeedback` を false にして止めたままである。移設の段では値を変えないためであり、`AvSyncStats.delays.audioDelayFeedback` もその状態を表示する

## 設計方針

第 1 段と同じ方針で進める。ブラウザ依存 (`AudioContext`、`requestAnimationFrame`、`MediaStreamTrackGenerator`、canvas) は注入し、共有実装は「時間軸への記録・目標の決定・`PlayoutBuffer` の扱い・計器への記録」を持つ。挙動は変えず、移設と共有化だけを行う。devtools 固有の判断 (relay の cache から追いつく途中の Object を再生しない、購読ごとの統計と画面への反映) は呼び出し側に残す。

### 第 1 段: 音声の再生の組み立て (完了済み)

- `src/audioPlayoutSession.ts` の `AudioPlayoutSession` が、復号した音声の時間軸への記録、目標の開始時刻の決定、`AudioPlayoutScheduler` への予約、計器 (`src/audioPlayoutTimingStats.ts`) への記録を行う
- ライブラリと devtools の両方がこれを使う。ブラウザ依存は `AudioPlayoutOutput` として注入する
- 呼び出し側の 2 ファイルで 387 行減った (追加 117 行・削除 504 行)
- `src/index.ts` から公開し、`docs/HIGH_LEVEL_API.md` と `CHANGES.md` に記載済み

### 第 2 段: 映像の再生の経路

- `src/videoPlayoutSession.ts` を新設し、復号したフレームの情報 (TIMESTAMP の種類と Object の位置) の対応表、共有の時間軸への記録、`PlayoutBuffer` への積み方とあふれの処理、表示の drain、表示の実績の記録、捨てたフレームの計器への記録を 1 か所に置く
- `src/createMediaSubscriber.ts` と `devtools/src/hooks/useSubscriber.ts` の両方から映像側の自前の組み立てを削除し、共有実装を使う
- `VideoDecodeOrder` / `GroupSwitchGate` / `PlayoutBuffer` / `PlaybackTimeline` / `CatchUpGate` は公開 API から使い、devtools に `../../../src/...` の相対 import を残さない (音声の分は第 4 段で扱う)
- `CatchUpGate` は `src/` へ移し、公開 API から使う
- 公開 API として `src/index.ts` から出し、`docs/HIGH_LEVEL_API.md` と `CHANGES.md` を更新する
- 挙動は変えない。devtools の統計、パネル、「Copy for LLM」の項目と `data-testid` を欠けさせない

### 第 3 段: 購読そのもの

- catalog の購読、音声と映像の購読、購読の世代管理、停止、ログをライブラリの共有実装へ寄せる
- devtools 側には、購読の進行を画面へ出すための signal への反映だけを残す

### 第 4 段: devtools の音声 Object の経路

- devtools の音声 Object の追いつきの判定、音声レベルの可視化、AAC の `AudioSpecificConfig` の適用を共有実装へ寄せる
- これで devtools 側から `../../../src/...` の相対 import による組み立てが無くなる

### 併せて行うこと

- devtools で音声の閉ループ (`AudioPlayoutSessionOptions.audioDelayFeedback`) を有効にし、`AvSyncStats.delays.audioDelayFeedback` の実測で目標が動くことを確かめる。有効化に伴い、`tests/e2e/devtools-av-sync.spec.ts` の「まだ動いていない」前提の期待値を実測に合わせる
- `tests/e2e/relay/audio-timestamp.spec.ts` の後始末を直す。Debug ツールバーを開いたまま `subscriber-stop-button` を押そうとすると、ボタンが Debug パネルに遮られ、Playwright の actionability の待ちがテストのタイムアウト (180 秒) を使い切る。ベースラインでも再現する既存の欠陥である。タイムアウトを伸ばすのではなく、UI の重なりを避けて実際に押せる状態にしてから押す (Debug パネルを閉じる、押せる位置へ寄せるなど)

## 完了条件

- devtools とライブラリの受信・再生の経路が 1 実装になり、devtools 側に `../../../src/...` の相対 import による組み立てが残っていない
- `vp check` / `tsc --noEmit` / `vp test` / Playwright (chromium・relay) が通る
- 挙動が変わっていない。既存の統計値 (受信・復号・再生・同期の各項目) と E2E の `data-testid` が同じである
- devtools の閉ループの有効化は、`AvSyncStats.delays.audioDelayFeedback` の実測を伴う
