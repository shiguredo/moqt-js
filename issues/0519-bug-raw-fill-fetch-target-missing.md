# 手組み FILL_PARAMETERS の fill 要求が購読に関連付けされない

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-raw-fill-fetch-target
- Polished: 2026-09-08

## 目的

`options.parameters` に手組みの正常な raw FILL_PARAMETERS を載せた `update()` は `REQUEST_OK` で resolve するのに、fill ストリームが購読に届かない。fill 要求と購読の関連付けを raw 経路にも広げる必要がある。

## 現状

- `bidiSendRequestUpdate`（`src/session/bidi.ts`）は `options.fill` が指定された場合のみ `fillFetchTargets` に登録し、`options.parameters` 経由の raw FILL_PARAMETERS では登録しない。
- `SUBSCRIBE` には raw パラメータを載せる公開経路がなく（`SubscribeOptions` に `parameters` はない）、問題は `REQUEST_UPDATE` の raw 経路に限定される。
- 受信側（`src/session.ts` のユニキャスト受信処理）は fill ストリームの `FETCH_HEADER` の Request ID で `fillFetchTargets` を引く。一致しない Request ID は `pendingFetch` に存在しないため `waitForFetcher` は即座に `null` を返し cancel されるため、raw FILL の fill オブジェクトは黙って届かない。

## 設計方針

- 原則として raw FILL の支援（下記 1）を採用する。既存テストが正常な raw FILL_PARAMETERS の送信を許容し、関連する `0520-bug-fill-duplicate-send-guard` と `0521-bug-raw-fill-range-limit-bypass` も raw 送信の継続を前提にしているため、送信自体の拒否（下記 2）は採用しない。

1. raw FILL を正式に支援するため、`options.parameters` 内の raw FILL_PARAMETERS が単一の場合に `fillFetchTargets` へ登録する。キーは新規採番の `updateRequestId` とし（`targetRequestId` ではない）、型付き経路と同形にする。`groupOrder` は内側の `GROUP_ORDER`（`MessageParameterType.GROUP_ORDER`）を `decodeFillParameters` で取り出して解決し、内側に `GROUP_ORDER` がなければ購読の指定を継承する（`resolveFillGroupOrder` と同規則）。内側の filter / timeout / priority 等はワイヤ上の値のままとし、登録側で追加の保持はしない。複数件・型付き併用時は `0520-bug-fill-duplicate-send-guard` の重複ガードが先に拒否するため、本 issue の登録対象は単一 FILL の場合に限る。
2. （不採用）支援しないなら、raw FILL 送信時に throw するか、少なくとも `RequestUpdateOptions.parameters` の説明に fill 配信の関連付けを行わない旨を明記する。

## 完了条件

- 単一の raw FILL を載せた `update()` の fill 要求が購読に届くこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.1.3 / §10.2.15
