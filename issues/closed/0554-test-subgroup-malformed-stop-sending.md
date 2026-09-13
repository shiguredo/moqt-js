# subgroup malformed テストで bidi リクエストストリームの STOP_SENDING を検証する

- Created: 2026-09-09
- Completed: 2026-09-14
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

## 解決方法

テストを強化した。実装は変えていない。

### 変更内容

`src/session.test.ts` の `Subgroup データストリーム: Mandatory Track Property で購読を cancel しセッションを閉じない` に、bidi リクエストストリームの cancel 検証を追加した。

- `ctx.internal.requestStreams` に購読の Request ID (1n) で実体の bidi ストリーム (`ReadableStream` / `WritableStream`) を登録する
- 検出後、readable の cancel が `"subscription cancelled"` で 1 回呼ばれること (STOP_SENDING 相当) と、writable の abort が同じ理由で 1 回呼ばれること (RESET_STREAM 相当) を検証する
- `requestStreams` からエントリが削除されることも検証する

あわせて `DataStreamFinContext` の `internal` 型に `requestStreams` を追加した (未登録のテストでは空 Map のまま使われない)。

### 裏付け

登録先の Request ID を 99n に変えて実行し、このテストが失敗することを実測した。`bidiCancelSubscription` の `if (streamInfo)` ブロックを通ることを検証できている。登録は 1n に戻している。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,135 テスト全通過 (テスト総数は変わらず、検証内容のみ強化)
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
