# LOC Timestamp に WebCodecs 時刻を載せ Timescale を無視している

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-loc-timestamp-semantics
- Polished: YYYY-MM-DD

## 目的

timescale 不在時の timestamp は Unix epoch からのマイクロ秒と定義されるが、WebCodecs の単調時刻を載せている。自家 round-trip はするが他実装と相互運用できない。

## 現状

- `src/createMediaPublisher.ts` の音声・映像ハンドラは `BigInt(chunk.timestamp)` を `TIMESTAMP` に載せ、`timescale` を送らない。
- `src/createMediaSubscriber.ts` の音声・映像ハンドラは `timescale` を捨て、メディア時刻をマイクロ秒としてデコーダに渡す。`duration` も一律 0 である。
- `src/loc.ts` の注釈自体は Unix epoch 前提を正しく引用しており、実装が自注釈に反する。

## 設計方針

1. 送信側は壁時計基準の timestamp を送るか、`TIMESCALE` を付けてメディア時刻であることを明示する (いずれかに統一)。
2. 受信側は `timescale` に応じて timestamp / duration を解釈する。

## 完了条件

- 送受信の時刻語義が loc-04 §2.3.1.1 / §2.3.1.2 と一致すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- refs/moq/draft-ietf-moq-loc-04.txt §2.3.1.1 / §2.3.1.2
