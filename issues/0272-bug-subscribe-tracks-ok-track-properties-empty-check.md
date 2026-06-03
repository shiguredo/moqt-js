# SUBSCRIBE_TRACKS_OK の Track Properties 空チェックが仕様違反

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18

## 目的

SUBSCRIBE_TRACKS_OK 応答で Track Properties が非空の場合に PROTOCOL_VIOLATION でセッションを閉じているが、仕様上 SUBSCRIBE_TRACKS_OK は空でなければならないメッセージ一覧に含まれていない。この検証を削除する。

## 優先度根拠

正当な Track Properties を含む SUBSCRIBE_TRACKS_OK 応答が PROTOCOL_VIOLATION で接続断になる仕様違反。相互運用性に致命的な影響がある。

## 現状

`src/session.ts:2059-2064` と `src/session.ts:2316-2322` で `validateRequestOkNoTrackProperties` を呼び出し、SUBSCRIBE_TRACKS_OK 応答の Track Properties 非空時に PROTOCOL_VIOLATION でセッションを閉じている。

仕様 §10.5 (REQUEST_OK) に列挙されている空必須メッセージは `PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK, PUBLISH_NAMESPACE_OK` の 4 つであり、`SUBSCRIBE_TRACKS_OK` は含まれていない。

draft-ietf-moq-transport-18 §10.5:
> Track Properties are populated in TRACK_STATUS_OK; they are empty in
> PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK.
> If an endpoint receives Track Properties in one of these messages it MUST
> close the session with a PROTOCOL_VIOLATION.

## 設計方針

- SUBSCRIBE_TRACKS_OK では Track Properties 空チェックを行わない
- もしくは §10.5 のテキストが 4 つのエイリアス名を例示列挙しているだけなのかを仕様確認する
- `startTracksStreamLoop` と `startNamespaceStreamLoop` (PUBLISH 受信ハンドラ) の両方から当該 `validateRequestOkNoTrackProperties` 呼び出しを削除する

## 完了条件

- SUBSCRIBE_TRACKS_OK 応答で Track Properties が非空でも PROTOCOL_VIOLATION が発生しない
- 関連テストが修正されている
