# SUBSCRIBE_NAMESPACE 応答ストリーム上の PUBLISH 受信を PROTOCOL_VIOLATION にする

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

`startNamespaceStreamLoop` 内で `MessageType.PUBLISH` を受信した場合に「実装の堅牢性のため受信可能」として処理しているが、§10.18 の SUBSCRIBE_NAMESPACE 応答ストリーム定義では NAMESPACE / NAMESPACE_DONE のみが許可されている。PUBLISH は §10.19 で別の双方向ストリーム上で送られるべきであり、SUBSCRIBE_NAMESPACE 応答ストリーム上での受信はプロトコル違反である。

## 経緯

この PUBLISH case は `issues/closed/0179-bug-subscribe-namespace-publish-message.md` で追加されたが、仕様確認の結果誤った判断であったため、本 issue で巻き戻す。

## 優先度根拠

仕様で定義されていないメッセージを許容することで、不適切な実装のサーバーとの相互運用時にプロトコル状態が破綻する。§10.18 の応答ストリーム定義に反する。

## 現状

`src/session.ts:1937-1947` (`startNamespaceStreamLoop`):

```typescript
case MessageType.PUBLISH: {
  // 実装の堅牢性のため受信可能にしておく。
  const decodedMsg = decodePublishPayload(messagePayload);
  const fullNamespace = trackNamespaceToStrings(decodedMsg.trackNamespace);
  const suffixStrings = fullNamespace.slice(subscription.namespacePrefix.length);
  const trackName = new TextDecoder().decode(decodedMsg.trackName);
  callbacks.onPublish?.(suffixStrings, trackName, decodedMsg.trackAlias);
  break;
}
```

`src/session.ts:522-531` (`NamespaceSubscriptionCallbacks`):

```typescript
onPublish?: (trackNamespaceSuffix: string[], trackName: string, trackAlias: bigint) => void;
```

PUBLISH が 2 つ目以降のメッセージとして来た場合、既存の `default` 分岐 (`src/session.ts:1948-1955`) が PROTOCOL_VIOLATION でセッションを閉じないため、明示的にハンドリングされている。先頭メッセージとして来た場合は既存の先頭メッセージチェック (`src/session.ts:1791-1807`) で捕捉される。

draft-ietf-moq-transport-18 §10.18 (SUBSCRIBE_NAMESPACE):

> If the SUBSCRIBE_NAMESPACE is successful, the publisher will send
> matching NAMESPACE messages on the response stream.

draft-ietf-moq-transport-18 §10.19 (SUBSCRIBE_TRACKS):

> the publisher will send PUBLISH messages on new bidirectional streams

## 設計方針

- `src/session.ts:1937-1947` の `case MessageType.PUBLISH:` ブロックを削除する
- 削除後は PUBLISH が既存の `default` 分岐に fall through し、PROTOCOL_VIOLATION でセッションが閉じられる
- `src/session.ts:522-531` の `NamespaceSubscriptionCallbacks.onPublish` コールバックを削除する
- 新規コードの追加は不要
- PUBLISH が先頭メッセージとして来た場合の既存チェックはそのまま維持する

## 完了条件

- SUBSCRIBE_NAMESPACE 応答ストリーム上の PUBLISH 受信が PROTOCOL_VIOLATION を引き起こす
- `NamespaceSubscriptionCallbacks.onPublish` が削除されている
- テストが追加されている
