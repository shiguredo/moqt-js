# SUBSCRIBE_NAMESPACE 応答ストリームで PUBLISH メッセージを処理できない

Created: 2026-05-13
Model: Opus 4.7

## 概要

`startNamespaceStreamLoop` (`src/session.ts:1519-1701`) は `NAMESPACE` / `NAMESPACE_DONE` / `PUBLISH_BLOCKED` を処理するが、`PUBLISH` メッセージが `SUBSCRIBE_NAMESPACE` 応答ストリーム上で届いた場合の処理がない。`default` 分岐で `PROTOCOL_VIOLATION` になりセッションが切断される。

## 一次資料の引用

draft-ietf-moq-transport-18 §6.1 (Subscribing to Namespaces) / §10.19 (SUBSCRIBE_TRACKS):

SUBSCRIBE_NAMESPACE 応答ストリームでは NAMESPACE / NAMESPACE_DONE が送られる (§6.1)。
一方、SUBSCRIBE_TRACKS 応答ストリームでは PUBLISH / PUBLISH_BLOCKED が送られる (§10.19)。
PUBLISH は SUBSCRIBE_TRACKS の応答ストリームに属し、SUBSCRIBE_NAMESPACE の応答ストリームには
本来送られない。

## 現状の実装

`src/session.ts:1667-1677` の `default` 分岐:

```typescript
default:
  this.closeWithError(
    new SessionError(
      `unknown namespace stream message type: 0x${messageType.toString(16)}`,
      SessionErrorCode.PROTOCOL_VIOLATION,
    ),
  );
  return;
```

`MessageType.PUBLISH` (0x1d) の case が存在しないため、PUBLISH メッセージが届くと `PROTOCOL_VIOLATION` でセッションが切られる。

## 期待される動作

SUBSCRIBE_NAMESPACE 応答ストリーム上で `MessageType.PUBLISH` を受信した場合、`decodePublishPayload` でデコードし、`NamespaceSubscriptionCallbacks` に新しく追加する `onPublish` コールバックでアプリケーションに通知する。

## 実装方針

1. `startNamespaceStreamLoop` の switch 文に `MessageType.PUBLISH` の case を追加
2. `decodePublishPayload` でデコード
3. `NamespaceSubscriptionCallbacks` に `onPublish?: (trackNamespaceSuffix: string[], trackName: string, trackAlias: bigint) => void` を追加
4. デコード結果をコールバックで通知

## 影響範囲

- `src/session.ts`: `startNamespaceStreamLoop` の switch 文
- `src/session.ts`: `NamespaceSubscriptionCallbacks` インターフェース
- `src/message/publish.ts`: `decodePublishPayload` が受信側で利用可能であることを確認

## テスト戦略

- SUBSCRIBE_NAMESPACE 応答ストリーム上で PUBLISH メッセージを受信した場合に `onPublish` が呼ばれること (単体テスト困難なため、relay との結合テストまたは PBT で対応)

## ブランチ命名

`feature/fix-` を使う。

## 完了条件

- `startNamespaceStreamLoop` で `MessageType.PUBLISH` を処理できる
- `NamespaceSubscriptionCallbacks` に `onPublish` が追加されている
- `vp run test` 全パス
- `vp run build` 成功
