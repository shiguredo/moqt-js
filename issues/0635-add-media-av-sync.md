# 音声と映像を LOC Timestamp と targetLatency で同期して再生する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/add-media-av-sync
- Polished: {YYYY-MM-DD}

## 目的

MSF は `renderGroup` が同じ track を「同時に描画するよう設計されている」と定め (draft-ietf-moq-msf-01 §5.2.11)、`targetLatency` を「符号化から表示までの wallclock の差」と定義する (§5.2.8)。LOC の Timestamp は Timescale が無ければ Unix epoch マイクロ秒の壁時計である (draft-ietf-moq-loc-04 §2.3.1.1)。

この 3 つを組み合わせると表示時刻は `Timestamp + targetLatency` で決まる。`createMediaSubscriber` はこの計算を行っておらず、音声と映像が別々の時計で再生されるため A/V 同期が成立しない。

## 現状

- `src/createMediaSubscriber.ts` の `handleAudioDecodedData` は `AudioBufferSourceNode` を作り `source.start()` を引数なしで呼ぶ。デコードした瞬間に再生される
- `src/createMediaSubscriber.ts` の `handleVideoDecodedData` は `MediaStreamTrackGenerator` に `VideoFrame` を書くだけで、表示時刻を決めていない
- `src/createMediaSubscriber.ts` の `decoderTimestampOf` は LOC Timestamp を WebCodecs の decode timestamp に変換するだけで、表示には使っていない
- カタログの `targetLatency` / `renderGroup` は `src/msf/types.ts` の `Track` にあり、`src/msf/catalogTrackValidation.ts` が型と `buffers` との排他を検証するが、再生時刻の決定に読むコードが無い
- publisher 側は `src/createMediaPublisher.ts` の `createMediaPublisher` が wall-clock の Timestamp を送っており、送信側の前提は整っている

## 設計方針

- 表示時刻を `LOC Timestamp + targetLatency` として求める。同じ `renderGroup` の track は同一の `targetLatency` を持つことが §5.2.8 で保証されているため、これだけで音声と映像が揃う
- `isLive` が false の track では `targetLatency` を無視する (§5.2.8 の MUST)。`targetLatency` が無い場合も現在の挙動へフォールバックする
- 音声は `AudioContext.currentTime` を基準に `AudioBufferSourceNode.start(when)` で予約再生する。デコードした瞬間に鳴らさない
- 映像は同じ基準時刻に合わせて表示する。`MediaStream` 経路では `VideoFrame` の timestamp を表示時刻に揃え、直接描画する利用者のために表示時刻を取得できるようにする
- 同期ずれの推定値を統計に持たせ、完了条件を判定できるようにする
- 対象は `src/createMediaSubscriber.ts` とし、必要なら `src/loc.ts` の時刻変換を補う

## 完了条件

- 音声と映像の表示時刻が同じ時間軸 (Unix epoch マイクロ秒) で計算される
- 120 秒程度の連続再生で A/V のずれが許容範囲 (例: ±50 ms) に収まる
- `isLive` が false のときに `targetLatency` を無視する
- `targetLatency` 未設定時のフォールバックがテストされている
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.2.8 (Target latency: 符号化から表示までの wallclock の差。同じ render group の track は同一の値でなければならない。`buffers` と併存しない)
- draft-ietf-moq-msf-01 §5.2.11 (Render group: 同じ group の track は同時に描画する SHOULD)
- draft-ietf-moq-msf-01 §5.2.7 (isLive: false なら targetLatency を無視する)
- draft-ietf-moq-loc-04 §2.3.1.1 (Timestamp: Timescale が無ければ Unix epoch マイクロ秒)

## 解決方法

{未着手}
