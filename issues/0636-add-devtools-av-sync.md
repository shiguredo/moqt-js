# devtools の音声と映像を同期して再生する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-av-sync
- Polished: {YYYY-MM-DD}

## 目的

devtools は相互運用を実測する道具であり、音声と映像がずれて再生されると「配信が正しいか」を目で判定できない。現状は映像を canvas へ即描画し、音声をデコードした瞬間に再生するため A/V 同期が成立しない。

MSF は `renderGroup` が同じ track を「同時に描画するよう設計されている」と定め (draft-ietf-moq-msf-01 §5.2.11)、`targetLatency` を「符号化から表示までの wallclock の差」と定義する (§5.2.8)。LOC の Timestamp は Timescale が無ければ Unix epoch マイクロ秒の壁時計である (draft-ietf-moq-loc-04 §2.3.1.1)。

## 現状

- `devtools/src/hooks/useSubscriber.ts` は `moqt-js` の `createMediaSubscriber` を使わず、`connect` / `subscribe` と `DecoderWrapper` / `AudioDecoderWrapper` で受信している
- 映像は `devtools/src/hooks/useSubscriber.ts` の `DecoderWrapper` の `output` から `renderFrame` を呼び、`CanvasRenderingContext2D.drawImage` で即描画する
- 音声は同じファイルで `AudioBufferSourceNode` を作り `source.start()` を引数なしで呼ぶ。デコードした瞬間に再生される
- カタログの `targetLatency` / `renderGroup` は `devtools/src/hooks/useSubscriber.ts` で読まれていない
- `window.moqtDevTools` の統計に同期ずれの指標が無く、E2E で判定できない

## 設計方針

- 表示時刻を `LOC Timestamp + targetLatency` として求める。devtools の publisher (`devtools/src/hooks/usePublisher.ts`) は `createMediaPublisher` を使わずに自前で送るが、映像は `src/mediaClock.ts` の `WallClockMapper` で読んだフレームとの対応から、音声は `LOC.toUnixEpochMicroseconds` で、どちらも wall-clock の Timestamp を送るため、購読側だけで同期が成立する
- 音声を `AudioContext.currentTime` 基準で予約再生し、映像を同じ時刻に合わせて描画する
- `isLive` が false のときは `targetLatency` を無視する (§5.2.8 の MUST)。`targetLatency` が無い場合も現在の挙動へフォールバックする
- 同期ずれの推定値を `devtools/src/signals/subscriber.ts` の signal に持たせ、`window.moqtDevTools` と `data-testid` から読めるようにする。E2E で判定できるようにするため
- ライブラリ側の「音声と映像を LOC Timestamp と targetLatency で同期して再生する」(0635) と計算方法を揃える。devtools は `createMediaSubscriber` を使わないため実装は共有できないが、ずれの定義と `isLive` / `targetLatency` 欠落時の扱いを一致させる

## 完了条件

- devtools で音声と映像が同じ時間軸で再生される
- 120 秒程度の連続再生で A/V のずれが許容範囲 (例: ±50 ms) に収まる
- `targetLatency` 未設定時と `isLive` が false のときのフォールバックがテストされている
- 同期ずれの推定値が `window.moqtDevTools` と `data-testid` から読める
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- draft-ietf-moq-msf-01 §5.2.8 (Target latency: 符号化から表示までの wallclock の差。同じ render group の track は同一の値でなければならない)
- draft-ietf-moq-msf-01 §5.2.11 (Render group: 同じ group の track は同時に描画する SHOULD)
- draft-ietf-moq-msf-01 §5.2.7 (isLive: false なら targetLatency を無視する)
- draft-ietf-moq-loc-04 §2.3.1.1 (Timestamp: Timescale が無ければ Unix epoch マイクロ秒)

## 解決方法

{未着手}
