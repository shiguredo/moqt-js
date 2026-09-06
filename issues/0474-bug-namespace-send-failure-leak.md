# namespace 系 3 API の送信失敗時にストリームリソースがリークする

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-namespace-send-cleanup
- Polished: YYYY-MM-DD

## 目的

`subscribeNamespace` / `subscribeTracks` / `publishNamespace` のストリーム取得後に送信失敗すると、reader / writer の解放も `Map` 登録もなくリソースが放置される。`publish` / `subscribe` / `fetch` と同等の後始末が必要である。

## 現状

- `src/session.ts` の 3 API は `createBidirectionalStream` / `getReader` / `getWriter` 取得後の `write` 失敗時に何も掃除しない。
- 対照的に `publish` / `subscribe` / `fetch` は送信失敗時に `pending` を削除する。

## 設計方針

1. 送信失敗時に reader / writer の解放 (`cancel` / `abort` / `releaseLock`) と状態掃除を行う。
2. 失敗パターンの単体テストを追加する。

## 完了条件

- 送信失敗時にリソースが残存しないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
