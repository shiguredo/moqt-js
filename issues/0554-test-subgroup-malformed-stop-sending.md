# subgroup malformed テストで bidi リクエストストリームの STOP_SENDING を検証する

- Created: 2026-09-09
- Completed: YYYY-MM-DD
- Branch: feature/add-subgroup-malformed-stop-sending-test
- Polished: YYYY-MM-DD

## 目的

subgroup の malformed track 検出時に `bidiCancelSubscription` が bidi リクエストストリームを cancel する（STOP_SENDING 相当）ことを固定する。現状のテストは `requestStreams` を登録しないため、Map 削除と error 通知のみを検証している。

## 現状

- `src/session.test.ts` の subgroup malformed テストは `subscribersByAlias` のみ登録する。
- `bidiCancelSubscription` の `if (streamInfo)` ブロック（`reader.cancel` / `writer.abort`）が実行されない。
- 既存の FETCH Priority 不一致テストは `requestStreams` を注入して cancel を検証しており、非対称である。

## 設計方針

1. `requestStreams` に stream を登録し、`reader.cancel` / `writer.abort` が呼ばれることを検証する。
2. 既存の FETCH Priority 不一致テストの検証方法と揃える。

## 完了条件

- subgroup の malformed track 検出で bidi リクエストストリームが cancel されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §2.4.2 / §5.1
- `bidiCancelSubscription` / `handleMalformedSubgroupTrack`
