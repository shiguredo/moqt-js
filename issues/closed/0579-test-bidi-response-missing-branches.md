# bidi 応答読み取りの未カバー分岐（REQUEST_ERROR / GOAWAY の 4 本）の回帰テストを追加する

- Created: 2026-09-12
- Completed: 2026-09-14
- Branch: feature/test-bidi-response-missing-branches
- Polished: {YYYY-MM-DD}

## 目的

`bidiReadResponse` のハンドラとして移設された REQUEST_ERROR / GOAWAY の 8 分岐のうち 4 本にテストがない。ハンドラのコピペミス (削除集合の漏れ・メッセージ文字列の相違) を検出できるようにする。

## 現状

- 未カバーの分岐は次の 4 本である。
  - `bidiReadPublishResponse` の REQUEST_ERROR (`retryInterval` / `redirect` を含む `RequestError` 構築)
  - `bidiReadSubscribeResponse` の REQUEST_ERROR (`fillFetchTargets` の削除)
  - `bidiReadSubscribeResponse` の GOAWAY (`goawayCallback` と 3 Map の削除)
  - `bidiReadTrackStatusResponse` の GOAWAY (`goawayCallback` を呼ばず、`newSessionUri` をメッセージに含める)
- PUBLISH の GOAWAY、FETCH の REQUEST_ERROR / GOAWAY、TRACK_STATUS の REQUEST_ERROR は既存テストでカバーされている。

## 設計方針

1. 4 本それぞれに、pending の reject (エラー型)、`requestStreams` (SUBSCRIBE は `fillFetchTargets` も) の削除、GOAWAY は `goawayCallback` と `goawayReceivedOnRequestStreams` の登録、TRACK_STATUS はメッセージ文字列を検証するテストを追加する。
2. 既存の `createOkResponseReadTestContext` を使い、テストの作法を揃える。
3. 既存テストの変更は行わない。

## 完了条件

- 上記 4 分岐のテストが追加され、削除集合・エラー型・GOAWAY の扱い・メッセージ文字列が検証されていること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `bidiReadResponse` / `bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadTrackStatusResponse` (`src/session/bidi.ts`)
- `createOkResponseReadTestContext` (`src/session/bidi.test.ts`)
- `issues/closed/0498-refactor-bidi-namespace-dedup.md`

## 解決方法

4 分岐のテストを追加した。実装は変えていない。issue 本文の `bidiReadResponse` は本作業の直前に `bidiDispatchResponse` へ改名済みである (0580)。

### 追加したテスト

`src/session/bidi.test.ts` に追加した。既存の `createOkResponseReadTestContext` を使っている。

- `bidiReadPublishResponse: REQUEST_ERROR の retryInterval と redirect が RequestError に載る`。`RequestError` のメッセージ / code / `retryInterval` / `redirect` を検証し、`pendingPublish` と `requestStreams` が削除され、セッションは閉じないことを確認する
- `bidiReadSubscribeResponse: REQUEST_ERROR で fillFetchTargets も削除される`。`pendingSubscribe` / `requestStreams` / `fillFetchTargets` の 3 つが削除されることを確認する
- `bidiReadSubscribeResponse: 確立前 GOAWAY で goawayCallback と削除集合が処理される`。`goawayCallback` に新しい URI が渡ること、3 つの削除、`goawayReceivedOnRequestStreams` への登録、reject メッセージ `request stream goaway` を確認する
- `bidiReadTrackStatusResponse: 確立前 GOAWAY は goawayCallback を呼ばずメッセージで通知する`。reject する Error のメッセージに `newSessionUri` が含まれること、`pendingTrackStatus` / `requestStreams` の削除、`goawayReceivedOnRequestStreams` への登録を確認する

### 実装中に判明した点

`REQUEST_ERROR` の Redirect は draft-ietf-moq-transport-21 §9.4.2 により Error Code が `REDIRECT` (0x34) のときだけ載る。他のコードで Redirect を含むワイヤは `ProtocolViolationError` になるため、テストでは `RequestErrorCode.REDIRECT` を使っている。また `RequestError.redirect` は decode 結果をそのまま保持するため、`trackNamespace` と `trackName` はバイト列で比較する。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,140 テスト全通過 (4 件増)
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
