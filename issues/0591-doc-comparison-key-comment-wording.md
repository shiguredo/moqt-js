# 比較キーを指すコメントが Full Track Name と書いている箇所を修正する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-comparison-key-comment-wording
- Polished: {YYYY-MM-DD}

## 目的

`getFullTrackNameKey` は Full Track Name そのものではなく `fullTrackNameKey` が生成する比較キーを返す。しかし周辺コメントには「Full Track Name で引く」「Full Track Name を保持する」と書かれた箇所が残っており、実体とずれている。読み手が生の Full Track Name (`"/"` 連結文字列など) を渡す実装を書くと、比較が一致せず cross-cancel が無言で空振りする。

## 現状

- `src/session/bidi.ts` の `cancelMalformedTrackPeers` の JSDoc に「fetcher は trackAlias を持たないため Full Track Name で引く」とあるが、実際に引くのは比較キー。
- `src/session/bidi.ts` の `PendingTrackStatus.trackKey` の JSDoc に「TRACK_STATUS 要求時の Full Track Name を保持する」とあるが、保持しているのは要求時の Full Track Name から生成した比較キー (`fullTrackNameKey`)。
- `src/session.ts` の `handleMalformedFetchTrack` のコメントに「Full Track Name で引く」とあるが、渡しているのは `FetcherImpl.getFullTrackNameKey()` の戻り値 (比較キー)。
- 3 箇所とも実装は比較キーで正しく動いており、コメントだけがずれている。挙動に影響はない。

## 設計方針

1. 3 箇所を「Full Track Name から生成した比較キーで引く / 保持する」と読み取れる記述に揃える。
2. 「同一 Track の判定は Full Track Name (trackNamespace + trackName) で行う」という仕様レベルの言明 (draft-ietf-moq-transport-21 §2.4.1) は残す。比較キーは Full Track Name と 1 対 1 であるため、結果の記述はそのままでよい。
3. コメントのみを変更し、コードは変更しない。

## 完了条件

- 3 箇所の記述が実体 (比較キー) と一致していること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加すること (コメント修正のため)。

## 関連

- `cancelMalformedTrackPeers` (`src/session/bidi.ts`) / `handleMalformedFetchTrack` (`src/session.ts`) / `getFullTrackNameKey` (`src/subscriber.ts` / `src/fetcher.ts`)
- `issues/closed/0584-refactor-rename-full-track-name-key.md` (比較キーを返すメソッド名を実体に合わせた issue)
