# FILL_PARAMETERS の重複送信に送信前ガードがない

- Created: 2026-09-07
- Completed: 2026-09-08
- Branch: feature/fix-fill-duplicate-send-guard
- Polished: 2026-09-08

## 目的

正常な raw FILL 2 件（または型付き fill と正常 raw FILL の併用）が 1 メッセージに載ると、対向がセッションを閉じうる不正ワイヤを送ってしまう。送信前に重複を拒否する必要がある。

## 現状

- `bidiSendRequestUpdate`（`src/session/bidi.ts`）は `options.parameters` 由来の raw FILL と `options.fill` 由来の型付き FILL を数えず、そのまま `parameters` に載せて送信する。
- 受信側の `decodeParameters`（`src/message/parameter.ts`）は `AUTHORIZATION_TOKEN` と Range Filter（0x25-0x29）以外の重複を `ProtocolViolationError` で拒否し、FILL_PARAMETERS（0x23）は繰り返し不可である。
- 仕様の §10.2 は送信側に重複禁止を `MUST NOT` で課し（明示的に複数 instance を許す定義がある場合を除く）、受信側の検査と `PROTOCOL_VIOLATION` を `SHOULD` で求める。§10.2.15 は複数 instance 許容の明示がないため、FILL_PARAMETERS（0x23）の重複送信は送信側の `MUST NOT` 違反になる。

## 設計方針

1. 送信前に `parameters`（raw と型付き構築後の合算）内の FILL_PARAMETERS 出現回数を数え、2 件以上なら送信前に `InvalidFilterError` で拒否する（`0465-bug-request-update-raw-fill-location-filter-bypass` の内側デコード検証ガードと同形）。配置は `pendingRequestUpdate.set` と `fillFetchTargets.set` より前とし、数え方は raw 同士の 2 件以上と型付き + raw 併用のいずれも対象にする。既存の raw 全件デコード検証（内側不正の `InvalidFilterError`）との前後は、重複検査を先に行い、二重不正入力では重複エラーを優先する。

## 完了条件

- FILL_PARAMETERS が 2 件以上になる `update()` が送信前に拒否され、`pendingRequestUpdate` に entry が残らないこと。
- 単一 FILL の正常送信は従来どおり行えること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- `src/session/bidi.ts` の `bidiSendRequestUpdate` に raw と型付きの合算計数による重複検査を追加し、2 件以上なら `pendingRequestUpdate.set` と `fillFetchTargets.set` と内側検証より前で `InvalidFilterError` にする
- 内側検証に到達しなくなった複数件テストを単一版に更新し、重複 3 件のテストを追加した。`0519` と `0521` が前提にする順序 (重複検査が先) を満たす
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 関連

- draft-ietf-moq-transport-20 §10.2 / §10.2.15
