# 確立前の namespace / tracks ストリームで GOAWAY が先頭メッセージだと PROTOCOL_VIOLATION になる

- Created: 2026-08-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-initial-goaway-on-namespace-stream
- Polished: {YYYY-MM-DD}

## 目的

SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS ストリームの先頭メッセージとして GOAWAY が到着した場合に、PROTOCOL_VIOLATION でセッションを閉じるのではなく、GOAWAY 処理 (マイグレーション通知) を行う。

## 現状

- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` (src/session/namespaceLoops.ts) の先頭メッセージガードは、REQUEST_OK / REQUEST_ERROR 以外のメッセージを PROTOCOL_VIOLATION でセッションを閉じる。
- draft-ietf-moq-transport-19 §10.4 は「A GOAWAY MAY also be sent on a request stream to initiate migration of that individual request.」と定めており、リクエストストリーム上の GOAWAY は確立前後を区別せず許可している。
- つまり、マイグレーション目的の正当な GOAWAY が REQUEST_OK 前に届いた場合、セッション全体が閉じる。PUBLISH_NAMESPACE ループ (namespaceStartPublicationStreamLoop) は resolved=false の GOAWAY を reject + cancel で処理しており、3 ループ間で挙動が不整合。

## 設計方針

- 先頭メッセージガードで GOAWAY を許可し、GOAWAY ケースへ流す。
- GOAWAY 後の処理は resolved=false のとき reject + cancel、resolved=true のとき goawayReceived フラグ + 読み取り継続 (0372 の実装と同様)。

## 完了条件

- SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS ストリームの先頭に GOAWAY が来てもセッションが閉じず、GOAWAY 処理が行われること。
- テストがあること。

## 解決方法

未着手。
