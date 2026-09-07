# 手組み FILL_PARAMETERS の fill 要求が購読に関連付けされない

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-raw-fill-fetch-target
- Polished: YYYY-MM-DD

## 目的

`options.parameters` に手組みの正常な raw FILL_PARAMETERS を載せた `update()` は `REQUEST_OK` で resolve するのに、fill ストリームが購読に届かない。fill 要求と購読の関連付けを raw 経路にも広げる必要がある。

## 現状

- `bidiSendRequestUpdate`（`src/session/bidi.ts`）は `options.fill` が指定された場合のみ `fillFetchTargets` に登録し、`options.parameters` 経由の raw FILL_PARAMETERS では登録しない。
- `SUBSCRIBE` 経路（`src/session.ts` の `subscribe`）も型付き fill の場合のみ登録するため、raw FILL はどちらの送信経路でも関連付けされない。
- 受信側（`src/session.ts` のユニキャスト受信処理）は fill ストリームの `FETCH_HEADER` の Request ID で `fillFetchTargets` を引く。一致しない場合は `waitForFetcher` のタイムアウト後に cancel されるため、raw FILL の fill オブジェクトは黙って届かない。

## 設計方針

1. raw FILL を正式に支援するなら、内側の `GROUP_ORDER` を解決して `fillFetchTargets` に登録する（内側に `GROUP_ORDER` がなければ購読の指定を継承する型付き経路と同規則）。
2. 支援しないなら、raw FILL 送信時に throw するか、少なくとも `RequestUpdateOptions.parameters` の説明に fill 配信の関連付けを行わない旨を明記する。

## 完了条件

- raw FILL の fill 要求が購読に届く、または raw FILL が送信前に拒否・文書化されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.1.3 / §10.2.15
