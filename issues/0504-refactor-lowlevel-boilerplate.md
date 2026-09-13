# 低レベル送受信の定型処理重複を除去する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/refactor-lowlevel-boilerplate
- Polished: YYYY-MM-DD

## 目的

ガードと配送処理の同型コードが分散し、フィルタ引数変更時に複数箇所修正が必要になる。共通化する必要がある。

## 現状

- `src/subscriber.ts` の `handleObject` / `handleDatagram` がフィルタ再適用まで約 20 行同一である。
- `src/publisher.ts` の `sendObject` / `sendDatagram`、`src/fetcher.ts` のガードが同型である。

## 設計方針

1. フィルタ照合とガードを共通ヘルパーに抽出する。
2. 送信ガードの振る舞い変更 (`0490`) との順序を調整する。

## 完了条件

- 重複が除去され、既存テストが全て通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0490` (送信ガードの振る舞い変更)

## 解決方法

3 箇所の同型処理を共通ヘルパーに集約した。挙動は変えていない。

### `SubscriberImpl` (src/subscriber.ts)

`handleObject` / `handleDatagram` が「Priority 省略時の継承 + Location Filter 再適用 + Range Filter 再適用」の同一 20 行を持っていたため、`passesObjectFilters(object)` に集約した。両メソッドは state ガード・フィルタ判定・コールバック呼び出し (`objectCallback` / `datagramCallback`) だけを行う。datagram 経路にだけあった「subgroupId が undefined のため SUBGROUP_FILTER は不通過」「Priority 未指定は PRIORITY_FILTER で不通過」のコメントは共通ヘルパー側に移した。

### `FetcherImpl` (src/fetcher.ts)

`handleObject` / `handleEnd` / `handleError` / `cancel` に散っていた `fetcherState === "closed"` ガード (5 箇所) を `isClosed` getter に集約した。

### `PublisherImpl` (src/publisher.ts)

`sendObject` / `sendDatagram` が持っていた「closed なら例外」「Forward State = 0 なら送信しない」「END_OF_TRACK 送信後は違反」の同一処理を `guardSend(kind)` に集約した。エラーメッセージの送信種別 (`object` / `datagram`) と、違反時の返し方の差 (sendObject は reject する Promise を返し sendDatagram は throw する) は呼び出し側に残している。Forward State = 0 で LARGEST_OBJECT / END_OF_TRACK を記録しない性質も共通ヘルパーの doc コメントに明記した。

### 検証

- 既存テスト 2,161 件が無変更で全通過 (挙動が変わっていないことの裏付け)
- `vp check` / `tsc --noEmit` 通過
- 差分: 3 ファイル、+79 / -71 行 (重複していた判定が 1 箇所になり、コメントの重複が減った)
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
