# SUBSCRIBE_NAMESPACE 応答ストリーム上の PUBLISH を PROTOCOL_VIOLATION にすべき

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18

## 目的

`startNamespaceStreamLoop` 内で `MessageType.PUBLISH` を受信した場合に「実装の堅牢性のため受信可能」として処理しているが、§10.18 の SUBSCRIBE_NAMESPACE 応答ストリーム定義では NAMESPACE / NAMESPACE_DONE のみが許可されている。PUBLISH 受信は PROTOCOL_VIOLATION でセッションを閉じるべき。

## 優先度根拠

仕様違反のデータを受信しているにもかかわらずセッションを閉じないため、不適切な実装のサーバーと相互運用した場合にプロトコル状態が破綻する可能性がある。

## 現状

`src/session.ts:1936-1940`:
```typescript
case MessageType.PUBLISH: {
  // draft-ietf-moq-transport-18 §10.10 (PUBLISH):
  // SUBSCRIBE_NAMESPACE 応答ストリーム上で PUBLISH が届いた場合の処理。
  // 仕様上 PUBLISH は SUBSCRIBE_TRACKS 応答に属するが、
  // 実装の堅牢性のため受信可能にしておく。
  const decodedMsg = decodePublishPayload(messagePayload);
```

draft-ietf-moq-transport-18 §10.18 (SUBSCRIBE_NAMESPACE): 成功時の応答ストリームは NAMESPACE および NAMESPACE_DONE のみ。PUBLISH は §10.19 (SUBSCRIBE_TRACKS) の応答として別の双方向ストリームで到着する。

## 設計方針

- SUBSCRIBE_NAMESPACE 応答ストリーム上の PUBLISH 受信時に PROTOCOL_VIOLATION でセッションを閉じる
- PUBLISH のコメントとコードを削除する

## 完了条件

- SUBSCRIBE_NAMESPACE 応答ストリーム上の PUBLISH 受信が PROTOCOL_VIOLATION を引き起こす
- テストが追加されている
