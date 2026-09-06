# Subscriber の復号フレーム破棄時にリソースがリークする

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-subscriber-frame-close
- Polished: YYYY-MM-DD

## 目的

書き込み失敗時に `VideoFrame` を閉じず、エラーごとにリークする。所有権方針を明確化して漏れをなくす必要がある。

## 現状

- `src/createMediaSubscriber.ts` の `handleVideoDecodedData` は `write` 失敗を握り潰すのみで `frame.close()` しない。成功時の所有権 (Generator 移譲) の注釈もない。
- `handleAudioDecodedData` の `createBuffer` は 0 フレームやクローズ済み `AudioContext` で throw しうるが `try/catch` がない。

## 設計方針

1. 失敗時に `frame.close()` し、成功時の所有権を注釈する。
2. 音声変換経路の例外を `error` コールバックへ届ける。

## 完了条件

- 書き込み失敗時にフレームが残存しないこと。音声変換失敗が通知されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
