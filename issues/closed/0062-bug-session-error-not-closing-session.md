# SessionError 発生時にセッションを閉じていない箇所がある

Created: 2026-03-29
Model: Opus 4.6

## 概要

SessionError が発生した際に `callbacks.error` を呼ぶだけで、実際にセッション (WebTransport) を閉じていない箇所が複数ある。

## RFC 根拠

draft-ietf-moq-transport-17 では複数のセクションで "MUST close the session" パターンが使われている。

draft-ietf-moq-transport-17 Section 3.3 Session initialization:

> Bidirectional streams MUST NOT begin with any other message type unless negotiated. If they do, the peer MUST close the Session with a PROTOCOL_VIOLATION.

draft-ietf-moq-transport-17 Section 3.5 Termination:

> PROTOCOL_VIOLATION (0x3): The remote endpoint performed an action that was disallowed by the specification.

> DUPLICATE_TRACK_ALIAS (0x5): The endpoint attempted to use a Track Alias that was already in use.

これらのエラーが発生した場合、セッションを閉じること (CONNECTION_CLOSE) が MUST である。エラーコールバックの通知だけではこの要件を満たさない。

## 該当箇所

- `src/session.ts` 行 2682-2690: 未知のメッセージタイプ受信時
- `src/session.ts` 行 2604-2611: 未知のメッセージタイプ受信時
- `src/session.ts` 行 3173-3179: 未知の単方向ストリームタイプ受信時
- 他にも `SessionError` を `callbacks.error` に渡した後に `close()` を呼んでいない箇所がある可能性

## 修正方針

SessionError 発生時に `callbacks.error` の呼び出しに加えて、WebTransport セッションの `close()` を適切なエラーコードで呼び出す。共通のエラーハンドリング関数を作成して一貫性を確保する。

## 解決方法

Completed: 2026-03-29

- `closeWithError(error: SessionError)` ヘルパーメソッドを追加し、`callbacks.error` 通知 + `close()` + `transport.close()` を一括で行うようにした
- 以下の箇所を `closeWithError` に統一した:
  - 制御ストリーム close 検出時 (PROTOCOL_VIOLATION)
  - 未知の namespace stream メッセージタイプ (PROTOCOL_VIOLATION)
  - DUPLICATE_TRACK_ALIAS エラー
  - FETCH_OK の end location バリデーション (PROTOCOL_VIOLATION)
  - 未知の request stream メッセージタイプ (PROTOCOL_VIOLATION)
  - 未知の control メッセージタイプ (PROTOCOL_VIOLATION)
  - 複数回の GOAWAY 受信 (PROTOCOL_VIOLATION)
  - 未知の単方向ストリームタイプ (PROTOCOL_VIOLATION)
