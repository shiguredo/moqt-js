# Standalone FETCH の End Location 検証を追加する

- Created: 2026-08-07
- Completed: 2026-08-07
- Branch: feature/fix-fetch-end-location-validation
- Polished: (未磨き上げ)

## 目的

draft-ietf-moq-transport-19 §10.12.3 は Standalone Fetch と Absolute Joining Fetch で End Location が Start Location 以上であることを MUST で要求している。moqt-js はこの検証を送信側で行っておらず、不正な FETCH をワイヤに載せてしまう。draft-19 対応のリリースに備えて送信前に検証する。

## 現状

- `SessionImpl.fetch` (`src/session.ts`) は `FetchOptions.startLocation` / `endLocation` を受け取り、`buildFetchParameters` と `encodeFetchPayload` 経由でそのまま FETCH メッセージを構築して送信する。startLocation > endLocation の場合も送信してしまう。
- 受信側の検証 (`validateFetchOkEndLocation`、`src/session/params.ts`) は存在するが、これは FETCH_OK の応答検証用であり FETCH 送信前の検証ではない。
- Joining Fetch (`bidiSendJoiningFetch`、`src/session/bidi.ts`) は publisher が End Location を計算するため送信側の検証対象外 (Absolute Joining の `joiningStart` はグループ ID であり Location 比較の対象ではない)。

## 設計方針

draft-ietf-moq-transport-19 §10.12.3 の記述に従う:

- "Fetch specifies an inclusive range of Objects starting at Start Location and ending at End Location. End Location MUST specify the same or a larger Location than Start Location for Standalone and Absolute Joining Fetches."

実装方針:

- Location の比較 (Group を先に比較し、同一 Group 内では Object を比較) をする純関数を `src/session/params.ts` に追加する。
- `SessionImpl.fetch` の送信前に検証し、startLocation > endLocation の場合は `Error` を throw する (送信しない)。
- エラーメッセージは検証済みの `validateFetchOkEndLocation` の表記と合わせる。

## 完了条件

- `fetch(namespace, trackName, { startLocation: { group: 2n, object: 0n }, endLocation: { group: 1n, object: 0n }, ... })` が throw する。
- 同一 Group 内で `startLocation.object > endLocation.object` の場合も throw する。
- startLocation == endLocation、startLocation < endLocation の場合は従来どおり送信できる。
- 上記の単体テストが追加され、`pnpm test` が全てパスする。

## 解決方法

- `src/session/params.ts` に Location 比較の純関数 `compareLocations` を追加する (draft-ietf-moq-transport-19 §1.4.2 の比較規則)
- `validateFetchOkEndLocation` を `compareLocations` で書き直して共通化する
- `SessionImpl.fetch` (`src/session.ts`) で End Location が Start Location 未満の場合に送信前に throw する
- テスト: `src/session/params.test.ts` に `compareLocations` / `validateFetchOkEndLocation` の単体テスト、`src/session.test.ts` を新規作成し `SessionImpl.fetch` の送信前検証テストを追加する
