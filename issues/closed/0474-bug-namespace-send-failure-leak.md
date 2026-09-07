# namespace 系 3 API の送信失敗時にストリームリソースがリークする

- Created: 2026-09-06
- Completed: 2026-09-07
- Branch: feature/fix-namespace-send-cleanup
- Polished: 2026-09-06

## 目的

`subscribeNamespace` / `subscribeTracks` / `publishNamespace` はストリーム取得後の送信失敗時に reader / writer を放置する。`Map` 登録は `write` より後のため残留しないが、取得済み `streamReader` / `writer` のロックが残る。`bidiSendRequestOnBidiStream` と同形 (RESET で閉じて `throw`、登録は成功時のみ) の後始末が必要である。

## 現状

- `src/session.ts` の 3 API は `createBidirectionalStream` / `getReader` / `getWriter` 取得後、`encode` / `build` の `throw` と `write` の失敗のいずれでも掃除しない。登録 (`namespaceSubscriptions` 等) は成功時のみのため `Map` 側の掃除は不要であり、対象はストリーム資源のみである。
- 対照的に `publish` / `subscribe` / `fetch` は `bidiSendRequestOnBidiStream` 内で `stream.readable.cancel` + `writer.abort` + `writer.releaseLock` (失敗無視) し、呼び出し側で `pending` を削除する。namespace 系は `readable` が `getReader` 済みでロック中のため、`streamReader.cancel` + `releaseLock` の pairing が必要であり同形転用はできない。
- `requestId` は 3 API・対照とも先行消費し、失敗時に巻き戻さない (巻き戻し不要)。

## 設計方針

1. ストリーム取得後の失敗時 (`encode` / `build` の `throw` と `write` の失敗) に `streamReader.cancel()` + `releaseLock`、`writer.abort()` + `releaseLock` (`finally`) を行い、元のエラーを再 `throw` する。`abort` / `cancel` 自体の失敗は無視する (`bidiSendRequestOnBidiStream` と同形。FIN である `close` は使わない)。登録は成功時のみのまま変えない。`requestId` は巻き戻さない。
2. 失敗パターンの単体テストを追加する (`write` reject と `encode` throw の両方)。

## 完了条件

- 送信失敗時に `writer.locked` が偽 (`releaseLock` 済み) で、対応する subscription Map に登録がないこと (3 API とも)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- `src/session.ts` の 3 API に取得済み資源の掃除ヘルパーを新設し、送信失敗時に cancel / abort (RESET 相当) してから throw する。登録は成功時のみのため Map 掃除は不要
- `src/session.test.ts` に write 失敗と送信前失敗のテスト 6 件を追加し、RESET 実行・ロック解放・Map 未登録を検証した。旧コードで落ちることを確認した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した
