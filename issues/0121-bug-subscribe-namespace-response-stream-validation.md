# SUBSCRIBE_NAMESPACE 応答ストリームの仕様 MUST/SHOULD 検証が複数欠落

Created: 2026-05-02
Model: Opus 4.7

## 概要

`SubscribeNamespace` のレスポンス受信処理 (`src/session.ts:1614-1670` 付近) は draft-17 §6.1 / §9.20 で規定された複数の MUST / SHOULD 検証を満たしていない。具体的には以下の 4 点。

1. 最初のフレームが REQUEST_OK / REQUEST_ERROR でないときの PROTOCOL_VIOLATION (MUST)
2. NAMESPACE_DONE が対応 NAMESPACE より前に届いたときの PROTOCOL_VIOLATION (MUST)
3. 仕様で許容されている PUBLISH_BLOCKED メッセージ受信を `default` で PROTOCOL_VIOLATION 扱いしてしまう
4. REQUEST_OK / REQUEST_ERROR が 2 回以上届いたときの protocol error 通知 (SHOULD)

## RFC 根拠

draft-ietf-moq-transport-17 §6.1 Subscribing to Namespaces (line 1925-1936):

> The subscriber sends SUBSCRIBE_NAMESPACE on a new bidirectional stream and the publisher MUST send a single REQUEST_OK or REQUEST_ERROR as the first message on the bidirectional stream in response to a SUBSCRIBE_NAMESPACE. The subscriber SHOULD close the session with a protocol error if it detects receiving more than one.

> If a Subscription cannot be created because there is no available Request ID, the Publisher sends a PUBLISH_BLOCKED message on the response stream to indicate the Full Track Name of the Subscription that could not be established. The Publisher MUST NOT send a PUBLISH for a Track after PUBLISH_BLOCKED has been sent.

draft-ietf-moq-transport-17 §9.20 SUBSCRIBE_NAMESPACE (line 4332-4384):

> The publisher will respond with REQUEST_OK or REQUEST_ERROR on the response half of the stream. If the subscriber receives any frame other than a REQUEST_OK or a REQUEST_ERROR as the first frame on the response half of the stream, then it MUST close the session with a PROTOCOL_VIOLATION.

> The publisher MUST NOT send NAMESPACE_DONE for a namespace suffix before the corresponding NAMESPACE. If a subscriber receives a NAMESPACE_DONE before the corresponding NAMESPACE, it MUST close the session with a 'PROTOCOL_VIOLATION'.

## 該当箇所

- `src/session.ts:1614-1670` 付近 — `readNamespaceSubscriptionResponse` 相当の switch
  - `case MessageType.NAMESPACE` (`1650 周辺`): `resolved` 状態に関係なく `onNamespace` を呼ぶ → 順序検証が欠落
  - `case MessageType.NAMESPACE_DONE` (`1656 周辺`): 受信済 suffix の追跡なし、ただ `onNamespaceDone` を呼ぶだけ → before-NAMESPACE 検証が欠落
  - `case MessageType.REQUEST_OK` (`1620 周辺`): `resolved` 既設定の二度目を素通しして `resolve()` を再実行 → 重複検出なし
  - `case MessageType.REQUEST_ERROR` (`1635 周辺`): `resolved` フラグを見ずに reject 経路に入る → REQUEST_OK 後の REQUEST_ERROR / 二度目の REQUEST_ERROR を検出しない
  - `default` (`1660 周辺`): PUBLISH_BLOCKED (0x0F) も unknown 扱いで PROTOCOL_VIOLATION クローズ

## 期待される動作

1. `resolved === false` の状態で REQUEST_OK / REQUEST_ERROR 以外を受信したら `closeWithError(SessionErrorCode.PROTOCOL_VIOLATION)`。
2. NamespaceSubscription ごとに「受信済 suffix 集合」を保持し、NAMESPACE_DONE 受信時に未登録の suffix なら `closeWithError(SessionErrorCode.PROTOCOL_VIOLATION)`。
3. `PUBLISH_BLOCKED` (`MessageType.PUBLISH_BLOCKED = 0x0F`) を switch case に追加し、`callbacks.onPublishBlocked?.(suffix, trackName)` を呼ぶ。あわせて `NamespaceSubscriptionCallbacks` 型に `onPublishBlocked` を追加する。
4. `resolved === true` の状態で REQUEST_OK / REQUEST_ERROR を受信したら `closeWithError` で SHOULD を満たす protocol-error クローズを行う。

## 優先度

重大。仕様準拠サーバが PUBLISH_BLOCKED を送ってきただけでセッションが PROTOCOL_VIOLATION 切断される（互換性破壊）。NAMESPACE 順序検証の欠落は敵対的サーバへの脆弱性。
