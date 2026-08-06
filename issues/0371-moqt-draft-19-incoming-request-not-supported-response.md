# 受信リクエストストリームの先頭メッセージを PROTOCOL_VIOLATION でセッション終了する

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-incoming-request-not-supported-response
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §3.3 で許可される 7 種のリクエストメッセージ (TRACK_STATUS / SUBSCRIBE / PUBLISH / FETCH / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) のうち、moqt-js が対応しないものを受信したときに、§4 (Extensibility) が求める NOT_SUPPORTED 応答を行う。現在は PUBLISH 以外のリクエストをすべて PROTOCOL_VIOLATION でセッション終了しており、仕様準拠のリレーと併用できない。

## 優先度根拠

`publishNamespace()` で広告した namespace に対し、§9.5 に従う仕様準拠リレーは SUBSCRIBE を送信する。このとき moqt-js はセッションを PROTOCOL_VIOLATION で閉じてしまうため、Namespace 公開機能が仕様準拠リレーと併用不能になる。Medium。

## 現状

- `src/session.ts:3303-3308` (`handleIncomingBidirectionalStream`) で、先頭メッセージが PUBLISH 以外の場合に `closeWithError(PROTOCOL_VIOLATION)` でセッションを閉じる。
- §3.3 では 7 種すべてがリクエストストリームの先頭メッセージとして許可されており、この検知は過剰。§4 は「Limited endpoints SHOULD respond to any unsupported messages with the appropriate NOT_SUPPORTED error code, rather than ignoring them.」と定める。

## 設計方針

- 受信 bidi ストリームの先頭メッセージが PUBLISH 以外のリクエストの場合、REQUEST_ERROR (NOT_SUPPORTED) を応答してストリームを閉じる。
- 制御ストリーム上の未知メッセージタイプ (§10 冒頭の MUST close) とは扱いを区別する。
- 受信 SUBSCRIBE 等への応答は行わず、アプリケーションへの通知も行わない (クライアント専用ライブラリとしての現状維持)。

## 完了条件

- 受信 bidi ストリームの先頭が PUBLISH 以外のリクエストの場合、セッションを閉じず REQUEST_ERROR (NOT_SUPPORTED) を応答してストリームを FIN で閉じること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3 (Session initialization)
- draft-ietf-moq-transport-19 §4 (Extensibility)
- draft-ietf-moq-transport-19 §10.6 (REQUEST_ERROR)

## 解決方法

未着手。
