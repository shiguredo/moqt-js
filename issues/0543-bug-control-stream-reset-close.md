# 制御ストリームの RESET_STREAM でセッションを PROTOCOL_VIOLATION で閉じる

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-control-stream-reset-close
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §3.3 は「A control stream MUST NOT be closed at the underlying transport layer during the session's lifetime. Doing so results in the session being closed as a PROTOCOL_VIOLATION.」と定める。現状はピアの RESET_STREAM で制御ストリーム読み取りが reject しても、セッションを閉じずに半壊状態が残る。

## 現状

- `src/session.ts` の `startControlMessageLoop` は、`reader.read()` が `done` を返した場合は `closeWithError(PROTOCOL_VIOLATION)` する。
- しかし `reader.read()` が reject した場合は catch で `notifyErrorIfActive` を呼ぶだけで、`notifyErrorIfActive` は `callbacks.error` を呼ぶのみ（`isSessionClosedError` 以外）。
- 結果として `sessionState` が `connected` のまま制御ループだけが終了し、制御メッセージを受信できないセッションが残る。

## 設計方針

1. 制御ストリーム読み取りループの catch で、セッション終了起因（`isSessionClosedError`）以外は `closeWithError(new SessionError(..., PROTOCOL_VIOLATION))` に落とす。
2. FIN 経路と RESET 経路を共通ヘルパーにまとめ、片方だけの修正漏れを防ぐ。
3. ピアの RESET_STREAM でセッションが PROTOCOL_VIOLATION で閉じるテストを追加する。

## 完了条件

- 制御ストリームの RESET_STREAM 検出でセッションが PROTOCOL_VIOLATION で閉じること。
- セッション終了起因の読み取り失敗では誤って閉じないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §3.3 / §3.5
- `startControlMessageLoop` / `notifyErrorIfActive`
- `isSessionClosedError` / `SessionErrorCode.PROTOCOL_VIOLATION`
