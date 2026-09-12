# 比較キーを branded type にして生の Full Track Name の取り違えを型で防ぐ

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-brand-full-track-name-key
- Polished: {YYYY-MM-DD}

## 目的

比較キー (`fullTrackNameKey` が生成する長さ付きキー) は `string` のまま扱われているため、生の Full Track Name や `"/"` 連結文字列を `cancelMalformedTrackPeers` に渡してもコンパイルが通る。渡した場合は一致する相手が無く、cross-cancel が無言で空振りする (セッションも閉じない)。branded type にしてキー生成関数の戻り値だけを比較キーとして受け取れるようにし、取り違えを型で検出する。

## 現状

- `src/fullTrackName.ts` の `fullTrackNameKey` は `string` を返す。
- `SubscriberImpl.getFullTrackNameKey` (`src/subscriber.ts`) / `FetcherImpl.getFullTrackNameKey` (`src/fetcher.ts`) も `string` を返す。
- `src/session/bidi.ts` の `PendingTrackStatus.trackKey` は `string`、`cancelMalformedTrackPeers` の引数 `trackKey` も `string`。
- 比較キーは `!==` による比較と `Set` / `Map` のキーとしてのみ使われるため、branded type にしても比較の実装は変えずに済む。
- `src/session.ts` の `handleIncomingBidirectionalStream` は `fullTrackNameKey` を直接呼んで比較するため、`fullTrackNameKey` の戻り値の型を変えれば両辺が branded になる。
- リポジトリに branded type / opaque type の前例は無い。

## 設計方針

1. `src/fullTrackName.ts` に比較キーの型 (例: `export type FullTrackNameKey = string & { readonly __brand: "FullTrackNameKey" }`) を追加し、`fullTrackNameKey` の戻り値をその型にする。
2. `SubscriberImpl.getFullTrackNameKey` / `FetcherImpl.getFullTrackNameKey` の戻り値、`PendingTrackStatus.trackKey`、`cancelMalformedTrackPeers` の引数を同じ型に揃える。
3. 生の Full Track Name を渡すコードが型エラーになることを実装中に一時的に確認する。テストファイルは `tsc` の対象外 (`tsconfig.json` の exclude) のため、恒久的な型テストは設けない。
4. 挙動は変えない。公開 API (`src/index.ts` / 生成される型定義) には出さない。

## 完了条件

- 比較キーの型が 1 箇所で定義され、生成関数・アクセサ・`PendingTrackStatus.trackKey`・`cancelMalformedTrackPeers` の引数が同じ型になっていること。
- 生の Full Track Name 文字列を `cancelMalformedTrackPeers` に渡すコードが型エラーになること (実装中に確認する)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- 公開 API の型定義 (`dist/index.d.ts`) に変化が無いこと。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加すること (内部の型付けの変更のため)。

## 関連

- `fullTrackNameKey` (`src/fullTrackName.ts`) / `getFullTrackNameKey` (`src/subscriber.ts` / `src/fetcher.ts`) / `cancelMalformedTrackPeers` / `PendingTrackStatus` (`src/session/bidi.ts`) / `handleIncomingBidirectionalStream` (`src/session.ts`) / `incomingHandleDatagram` (`src/session/incoming.ts`)
- `issues/closed/0584-refactor-rename-full-track-name-key.md` (比較キーを返すメソッド名を実体に合わせた issue)
