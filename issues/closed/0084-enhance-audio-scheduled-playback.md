# Subscriber の audio 再生を AudioContext.currentTime ベースでスケジュールする

Created: 2026-04-19
Completed: 2026-04-19
Model: Opus 4.7

## 概要

`createMediaSubscriber.ts` の `handleAudioDecodedData` は、デコード済み `AudioData` を `AudioBufferSourceNode.start()` (引数なし) で即時再生している。`AudioContext.currentTime` を使った未来時刻スケジューリングを行っていないため、受信ジッタがそのまま再生ジッタとなり、フレーム間の隙間や重なりで音が割れる / 途切れる可能性が高い。

## 根拠

Web Audio API の仕様上、`AudioBufferSourceNode.start(when)` で指定する `when` は `AudioContext.currentTime` と同じ時間軸上の絶対時刻であり、引数省略時は「可能な限り即座に」開始される。連続再生のためには、直前にスケジュール済みフレームの終了時刻を保持し、次フレームをその時刻以降にスケジュールする必要がある。これを行わない場合、`AudioBufferSourceNode` はスケジューラによってわずかに前後にずれ、ギャップやオーバーラップが発生する。

WebCodecs で復号した `AudioData` を連続再生する場合の定石は、以下のパターンである。

1. `nextPlaybackTime` を内部状態として保持する。
2. 初回フレームは `currentTime + jitterBuffer` から開始 (ジッタ吸収)。
3. 2 フレーム目以降は `max(currentTime + jitterBuffer, nextPlaybackTime)` をスケジュール時刻とする。
4. `nextPlaybackTime = startAt + frameDurationSec` で更新する。
5. 送受信ペース差で `nextPlaybackTime` が `currentTime` を大きく超えた場合 (過剰遅延) は再同期する。
6. フレームが遅延して `nextPlaybackTime < currentTime` になった場合もジッタバッファ分を前倒しして再スケジュールする。

## 該当箇所

- `src/createMediaSubscriber.ts:644-676` `handleAudioDecodedData`
- `src/createMediaSubscriber.ts:100-108` audio 再生関連の state フィールド

## 現状のコード

```ts
private handleAudioDecodedData(data: { data: AudioData }): void {
  if (!this.audioContext || !this.audioDestination) {
    data.data.close();
    return;
  }
  // ... AudioBuffer に変換 ...
  const source = this.audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(this.audioDestination);
  source.start();  // 引数なし → 即時再生
  audioData.close();
}
```

## 修正方針

1. スケジュール計算を純粋関数 `computeAudioPlaybackSchedule` として切り出し、`src/createMediaSubscriber.ts` 内で export する。
   - 入力: `currentTime`, `nextPlaybackTime` (null 可), `frameDurationSec`, `jitterBufferSec`, `maxDriftSec`
   - 出力: `{ startAt: number, nextPlaybackTime: number, resynced: boolean }`
2. `MediaSubscriberImpl` に `audioNextPlaybackTime: number | null` を追加し、`handleAudioDecodedData` で `computeAudioPlaybackSchedule` を呼び出して `source.start(startAt)` に渡す。
3. デフォルト値: `jitterBufferSec = 0.06` (60 ms), `maxDriftSec = 0.5` (500 ms)。
4. `close()` / subscribe 停止時に `audioNextPlaybackTime` を null リセットする。

## テスト

CLAUDE.md に従い「変更前にテストを先に修正する」。

- `src/createMediaSubscriber.test.ts` を新設し、`computeAudioPlaybackSchedule` の単体テストを追加する。
  - 初回呼び出し (nextPlaybackTime=null) で `currentTime + jitterBufferSec` を返すこと
  - 連続呼び出しで単調増加すること
  - `nextPlaybackTime - currentTime` が `maxDriftSec` を超えた場合に `resynced=true` で `currentTime + jitterBufferSec` に戻ること
  - フレーム遅延で `nextPlaybackTime < currentTime` の場合にジッタバッファを加えて前倒しすること
- `src/createMediaSubscriber.prop.ts` を新設し、fast-check で
  - `nextPlaybackTime` が単調増加またはリセット後に現在時刻以降であること
  - `startAt >= currentTime` が常に成立すること
  - を担保する。

## 検証

- `vp run build` (vite build + tsc) が通ること。
- `vitest run` で既存 + 新規テストがすべて通ること。
- e2e 動作確認 (examples 起動による実音声再生) は今回は対象外。

## 解決方法

- `src/createMediaSubscriber.ts` に純粋関数 `computeAudioPlaybackSchedule` と型 `AudioPlaybackScheduleInput` / `AudioPlaybackScheduleOutput` を追加した。
- 定数 `DEFAULT_AUDIO_JITTER_BUFFER_SEC = 0.06` と `DEFAULT_AUDIO_MAX_DRIFT_SEC = 0.5` を追加した。
- `MediaSubscriberImpl` に `audioNextPlaybackTime: number | null` を追加し、`handleAudioDecodedData` で `computeAudioPlaybackSchedule` の結果を使って `source.start(startAt)` を呼ぶように変更した。
- `close()` で `audioNextPlaybackTime` を null にリセットするようにした。
- `src/createMediaSubscriber.test.ts` で初回 / 連続 / 遅延 / 過剰先行 / 境界ケースの単体テストを追加した。
- `src/createMediaSubscriber.prop.ts` で `startAt >= currentTime`、resynced 時の開始時刻、resynced=false 時の nextPlaybackTime 更新、drift 上限を fast-check で検証した。
