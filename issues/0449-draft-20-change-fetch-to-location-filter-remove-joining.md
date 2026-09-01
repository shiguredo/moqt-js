# FETCH を Location Filter ベースに変更し Joining FETCH を削除する

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/change-fetch-to-location-filter-remove-joining
- Polished: 2026-09-01

## 目的

draft-ietf-moq-transport-20 §10.13 で FETCH ワイヤが Track Namespace / Track Name + Parameters のみになり、Fetch Type / Standalone の Start/End Location / Joining 変種が削除された。実装を draft-20 に合わせ、Joining FETCH API を除去する。

## 現状

- `src/message/fetch.ts` の `Fetch` / `FetchType` / `StandaloneFetch` / `JoiningFetch` / `encodeFetchPayload` / `decodeFetchPayload` は draft-19 §10.12 形 (Fetch Type 0x01–0x03、Standalone の start/end Location、Joining の joiningRequestId / joiningStart)。
- `Session.fetch()` (`src/session.ts`) は `FetchType.STANDALONE` で開始 Location / 終了 Location をメッセージフィールドに載せる。
- `bidiSendJoiningFetch` / `JoiningFetchOptions` (`src/session/bidi.ts`, `src/session.ts`) と `createMediaSubscriber` の joining 経路が Joining FETCH を送る。
- `RequestErrorCode.INVALID_JOINING_REQUEST_ID` (0x32) (`src/error.ts`) が残存するが、draft-20 の REQUEST_ERROR コードから削除された。
- `createMediaSubscriber` の catalog フェーズ終了 (`finishCatalogFetchPhase`) は Joining FETCH の `onEnd` / `onError` に依存しており、単純な削除では `createMediaSubscriber` が catalog 受信でハングする。
- devtools (`devtools/src/hooks/useSubscriber.ts` / `devtools/src/components/SubscriberPanel.tsx` / `devtools/src/components/DebugPanel.tsx` 等) と `createMediaSubscriber` (`MediaSubscriberOptions.joiningFetch` 経由) に `JoiningFetchOptions` / `joiningFetch` 参照があり、削除に追随が必要。
- 前提: Location Filter ワイヤ再構成 (`issues/0448-draft-20-restructure-location-filter-wire.md`)。

## 設計方針

- FETCH ペイロードを draft-20 §10.13 の形 (Request ID + Track Namespace + Track Name + Parameters) に変更する。範囲は `LOCATION_FILTER` パラメータで表現する。
- `FetchType` / `StandaloneFetch` / `JoiningFetch` / `bidiSendJoiningFetch` / `JoiningFetchOptions` (`src/session.ts` / `src/session/bidi.ts`) を削除する。`SubscribeOptions.joiningFetch` / `MediaSubscriberOptions.joiningFetch` を含む公開 API 参照 (`src/index.ts` 経由を含む) からも外す。
- `Session.fetch()` のオプションを Location Filter + その他 Parameters に合わせて更新する。
- `INVALID_JOINING_REQUEST_ID` を削除し、正規化・テストを追随させる。
- `createMediaSubscriber` は catalog フェーズ終了のトリガを Joining FETCH の `onEnd` / `onError` から外し、ハングせずに catalog 受信を完了できる設計に変更する (`finishCatalogFetchPhase` の呼び出し元を Joining FETCH 非依存にする)。
- devtools の `JoiningFetchOptions` import / `joiningFetch` 参照 (UI・統計・テスト含む) を除去し、`vp check` / `tsc --noEmit` / `vp test run` が通る状態にする。fill への UI 移行は 0450 の責務とする。
- Joining の代替は FILL_PARAMETERS (`issues/0450-draft-20-add-fill-parameters-and-fill-fetch.md`) で扱う。本 issue では Joining 経路を削除し、削除に追随する全参照 (ライブラリ本体 / `createMediaSubscriber` / `createMediaPublisher` / devtools) をコンパイル可能にする変更に留める (fill 実装は 0450)。

## 完了条件

- FETCH encode / decode が draft-20 §10.13 と一致し、Fetch Type / Joining フィールドが残っていないこと。
- `Session.fetch()` が範囲を `LOCATION_FILTER` で送ること。
- `bidiSendJoiningFetch` / `JoiningFetchOptions` / `SubscribeOptions.joiningFetch` / `MediaSubscriberOptions.joiningFetch` / `FetchType` / `INVALID_JOINING_REQUEST_ID` が削除されていること。
- `createMediaSubscriber` が Joining FETCH に依存せず catalog 受信を完了でき、devtools を含む全参照がコンパイル可能であること。
- 関連テスト・プロパティテストが新形式に更新されていること。
- `CHANGES.md` の `## develop` に `[CHANGE]` があること (破壊的変更のため)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.13 (FETCH)
- draft-ietf-moq-transport-20 §10.2.9 (LOCATION FILTER Parameter)
- draft-ietf-moq-transport-20 Appendix A.1 (#1673, #1809)
- 前提: `issues/0448-draft-20-restructure-location-filter-wire.md`
- 後続: `issues/0450-draft-20-add-fill-parameters-and-fill-fetch.md`
