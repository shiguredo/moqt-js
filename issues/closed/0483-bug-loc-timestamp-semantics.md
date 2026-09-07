# LOC Timestamp に WebCodecs 時刻を載せ Timescale を無視している

- Created: 2026-09-06
- Completed: 2026-09-07
- Branch: feature/fix-loc-timestamp-semantics
- Polished: 2026-09-06

## 目的

timescale 不在時の timestamp は Unix epoch からのマイクロ秒と定義されるが、WebCodecs の単調時刻を載せており、仕様に従う受信者と解釈がずれる。自家では送受が同一解釈のため動作するが、wire 値は仕様に反する。

## 現状

- `src/createMediaPublisher.ts` の音声・映像ハンドラは `BigInt(chunk.timestamp)` を `TIMESTAMP` に載せ、`timescale` を送らない。
- `src/createMediaSubscriber.ts` の音声・映像ハンドラは `timescale` を捨て、メディア時刻をマイクロ秒としてデコーダに渡す。`duration` も一律 0 である。
- `src/loc.ts` の注釈自体は Unix epoch 前提を正しく引用しており、実装が自注釈に反する。

## 設計方針

1. 送信側は壁時計基準 (Unix epoch マイクロ秒、`performance.timeOrigin` 基準で換算) の timestamp を送り、`TIMESCALE` は付けない。`TIMESCALE` 付きメディア時刻への対応は本 issue では行わない。
2. 受信側は `timescale` 不在時は値をそのまま渡す (現状維持)。`timescale` 有り時はマイクロ秒換算 (`timestamp * 1_000_000 / timescale`) して渡す。`duration` は LOC Properties に存在しないため対象外とし 0 を維持する。
3. 送受の時刻語義テストを追加する (送信 TIMESTAMP の Unix epoch 範囲検証、`timescale` 有り時の換算検証)。

## 完了条件

- 送信 TIMESTAMP が Unix epoch マイクロ秒範囲 (現在時刻前後の許容幅) に入ること。
- `timescale` 有り受信で換算値がデコーダに渡ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- 送信側は WebCodecs 時刻を Unix epoch マイクロ秒に換算して送り、TIMESCALE は付けない。受信側は TIMESCALE 有り時のみマイクロ秒換算し、不在時と不正値はそのまま渡す
- 送受の時刻語義テスト 10 件を追加した。旧コードで落ちることを確認した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 関連

- refs/moq/draft-ietf-moq-loc-04.txt §2.3.1.1 / §2.3.1.2
