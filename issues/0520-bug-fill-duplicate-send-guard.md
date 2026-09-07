# FILL_PARAMETERS の重複送信に送信前ガードがない

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-fill-duplicate-send-guard
- Polished: YYYY-MM-DD

## 目的

正常な raw FILL 2 件（または型付き fill と正常 raw FILL の併用）が 1 メッセージに載ると、対向がセッションを閉じうる不正ワイヤを送ってしまう。送信前に重複を拒否する必要がある。

## 現状

- `bidiSendRequestUpdate`（`src/session/bidi.ts`）は `options.parameters` 由来の raw FILL と `options.fill` 由来の型付き FILL を数えず、そのまま `parameters` に載せて送信する。
- 受信側の `decodeParameters`（`src/message/parameter.ts`）は `AUTHORIZATION_TOKEN` と Range Filter（0x25-0x29）以外の重複を `ProtocolViolationError` で拒否し、FILL_PARAMETERS（0x23）は繰り返し不可である。
- 仕様の §10.2 も重複パラメータの検査と `PROTOCOL_VIOLATION` を SHOULD で求め、§10.2.15 は重複送信を許可していない。

## 設計方針

1. 送信前に `parameters`（raw と型付き構築後の合算）内の FILL_PARAMETERS 出現回数を数え、2 件以上なら送信前に拒否する。

## 完了条件

- FILL_PARAMETERS が 2 件以上になる `update()` が送信前に拒否されること。
- 単一 FILL の正常送信は従来どおり行えること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.2 / §10.2.15
