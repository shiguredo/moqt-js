# Subscriber の復号フレーム破棄時にリソースがリークする

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-subscriber-frame-close
- Polished: 2026-09-06

## 目的

書き込み失敗時に `VideoFrame` を閉じず、エラーごとにリークする。所有権方針を明確化して漏れをなくす必要がある。

## 現状

- `src/createMediaSubscriber.ts` の `handleVideoDecodedData` は `write` 失敗を握り潰すのみで `frame.close()` しない (`catch` は引数なしで `frame` を捕捉しない)。`videoWriter` 不在経路は `close` 済みで正常であり、成功時は Generator 所有のため `close` しない方針とみられるが注釈がない。
- `handleAudioDecodedData` に `try/catch` がなく、`createBuffer` (0 フレーム・クローズ済み context) を含む変換全体の throw 時に `audioData.close()` も漏れる。`audioContext` 不在経路は `close` 済みで正常である。

## 設計方針

1. 映像は `catch` で `frame` を捕捉して `close` する。成功時は Generator 所有のため `close` しない旨を注釈する。
2. 音声は変換全体 (`createBuffer`〜`start`) を `try` し、`finally` で `audioData.close()`、`catch` で `this.callbacks.onError` へ通知する。

## 完了条件

- 書き込み失敗時に `frame.closed` が真であること。音声変換失敗時に `onError` が呼ばれ、`audioData` が閉じられること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
