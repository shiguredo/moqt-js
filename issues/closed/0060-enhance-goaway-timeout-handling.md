# GOAWAY Timeout 処理を実装する

Created: 2026-03-29
Model: Opus 4.6

## 概要

GOAWAY 送受信後のタイムアウト処理が未実装である。

## RFC 根拠

draft-ietf-moq-transport-17 Section 9.5 GOAWAY:

> Timeout: The time in milliseconds the sender will wait for the session to be gracefully closed before closing the session with GOAWAY_TIMEOUT. A value of 0 indicates the sender has no specific timeout, and the recipient SHOULD still close the session as quickly as possible. This is a hint; the sender of the GOAWAY MAY close the session before the indicated timeout has elapsed.

draft-ietf-moq-transport-17 Section 3.6 Migration:

> The GOAWAY message contains a Timeout indicating how long, in milliseconds, the sender intends to wait before closing the session. The sender SHOULD close the session with GOAWAY_TIMEOUT after the indicated timeout if there are still open subscriptions or fetches on a connection.

> The sender closes the session with a GOAWAY_TIMEOUT if the peer doesn't close the session within the indicated Timeout.

draft-ietf-moq-transport-17 Section 3.5 Termination:

> GOAWAY_TIMEOUT (0x10): The session was closed because the peer took too long to close the session in response to a GOAWAY (Section 9.5) message. See session migration (Section 3.6).

## 該当箇所

- `src/session.ts`: GOAWAY 送受信処理にタイムアウト機構がない

## 修正方針

GOAWAY 送信後にタイマーを設定し、タイムアウト経過時に未クローズのサブスクリプション/Fetch が存在すれば `GOAWAY_TIMEOUT` でセッションを閉じる。

## 解決方法

Completed: 2026-03-29

- `SessionImpl` に `goawayTimeoutId` フィールドを追加した
- `goaway()` メソッドで timeout > 0 の場合に `setTimeout` でタイマーを設定し、タイムアウト経過時にセッションが接続中であれば `GOAWAY_TIMEOUT` で `closeWithError` を呼ぶようにした
- `close()` メソッドでタイマーをクリアするようにした
