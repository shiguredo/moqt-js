# Mandatory Track Property の FETCH session レベル回帰テストを追加する

- Created: 2026-09-09
- Completed: 2026-09-14
- Branch: feature/add-fetch-mandatory-track-session-test
- Polished: YYYY-MM-DD

## 目的

`decodeFetchObjectFields` の Mandatory Track Property 検出が、session レベルの `handleMalformedFetchTrack` 経路で FETCH を cancel し、セッションを閉じないことを結合テストで固定する。現状は decoder 単体テストのみで、新トリガ固有の session レベルテストが無い。

## 現状

- `src/dataStream.fetch.test.ts` に `decodeFetchObjectFields` が Mandatory Track Property で `MalformedTrackError` を throw する単体テストがある。
- session レベルの FETCH malformed テストは Priority 不一致のみで、Mandatory Track Property 版は無い。
- `MalformedTrackError` は `processFetchObjects` → `handleIncomingStream` の catch → `handleMalformedFetchTrack` に到達する。

## 設計方針

1. FETCH データストリームに Mandatory Track Property を含む Object を流し、fetcher が cancel されセッションが閉じないことを検証する。
2. 既存の `handleMalformedFetchTrack` 経路と整合させる。

## 完了条件

- Mandatory Track Property を含む FETCH Object で fetcher が cancel され、セッションが閉じないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §2.5.1 / §2.4.2
- `decodeFetchObjectFields` / `handleMalformedFetchTrack`

## 解決方法

テストを追加した。issue の参照は draft-20 の節番号だが、現在の一次資料 draft-ietf-moq-transport-21 では §3.6 (Malformed Track の Property 違反) / §12.1 (Malformed Tracks) に対応するため、コメントは draft-21 の節番号に合わせている。

### 追加したテスト

`src/session.test.ts` に `FETCH データストリーム: Mandatory Track Property で FETCH を cancel しセッションを閉じない` を追加した。既存の `createFetchPriorityMismatchContext` を再利用し、FETCH データストリームに Mandatory Track Property (0x4000) を含む Object Property を持つ先頭 Object を流す。

検証項目は既存の Priority 不一致テストと同じ並びに揃えた。

- セッションは閉じない (`sessionError.current` が undefined)
- 受信データストリームが STOP_SENDING 相当で打ち切られ、理由に `malformed track` を含む
- bidi リクエストストリームへ STOP_SENDING が送られる (`bidiCancelledReason.current` が `"fetch cancelled"`)
- `fetchers` / `requestStreams` から削除される
- error コールバックが `MalformedTrackError` で呼ばれる

### 裏付け

Object Property を含めないワイヤ (`buildFetchStreamParts(requestId)`) に差し替えて実行し、このテストが失敗することを実測した。malformed 検出が cancel の原因であることを確認できている。差し替えは元に戻している。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,136 テスト全通過 (1 件増)
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
