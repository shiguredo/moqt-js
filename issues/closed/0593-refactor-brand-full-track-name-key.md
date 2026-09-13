# 比較キーを branded type にして生の Full Track Name の取り違えを型で防ぐ

- Created: 2026-09-12
- Completed: 2026-09-14
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

## 解決方法

実装した。

### 型の定義

`src/fullTrackName.ts` に `export type FullTrackNameKey = string & { readonly __brand: "FullTrackNameKey" }` を追加し、`fullTrackNameKey` の戻り値を `FullTrackNameKey` にした。brand は型のみで実行時表現を持たないため、生成は `fullTrackNameKey` の 1 箇所で `as FullTrackNameKey` を 1 回だけ使い、他のコードはブランド済みの値をそのまま受け渡す。実行時の値は従来と同じ文字列である。

### 型を揃えた箇所

- `src/subscriber.ts` の `SubscriberImpl.getFullTrackNameKey` の戻り値
- `src/fetcher.ts` の `FetcherImpl.getFullTrackNameKey` の戻り値
- `src/session/bidi.ts` の `PendingTrackStatus.trackKey`
- `src/session/bidi.ts` の `cancelMalformedTrackPeers` の引数 `trackKey`

`src/session.ts` の `handleIncomingBidirectionalStream` は `fullTrackNameKey` の戻り値と比較するため、生成関数の戻り値の型を変えるだけで両辺が branded になった。

### 型で防げることの確認

生の Full Track Name を渡すコードを一時的に置いて `vp check` を実行し、`TS2345: Argument of type 'string' is not assignable to parameter of type 'FullTrackNameKey'` になることを確認した。issue の設計方針どおり、テストファイルは `tsc` の対象外であるため恒久的な型テストは置いていない。

### 公開 API への影響

`vp pack` でビルドし、`dist/index.d.ts` に `FullTrackNameKey` が出現しないこと (0 件) を確認した。公開インターフェース `Subscriber` / `Fetcher` は `getFullTrackNameKey` を持たず、`src/index.ts` も `FullTrackNameKey` を export していない。

### テスト

挙動を変えないため新規テストは追加していない。比較キーの生成規則は既存の `src/fullTrackName.prop.ts` (Impl の `getFullTrackNameKey` と free 関数が同じキーを返すこと、異なるフィールド列が同じキーにならないこと) が引き続き検証している。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,126 テスト全通過
- `vp pack` 成功、`dist/index.d.ts` に型の変化なし
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
