# bidi 応答読み取りの未カバー分岐（REQUEST_ERROR / GOAWAY の 4 本）の回帰テストを追加する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
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
