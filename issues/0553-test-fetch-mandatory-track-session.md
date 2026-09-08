# Mandatory Track Property の FETCH session レベル回帰テストを追加する

- Created: 2026-09-09
- Completed: YYYY-MM-DD
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
