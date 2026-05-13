# SUBSCRIBE_NAMESPACE を SUBSCRIBE_NAMESPACE と SUBSCRIBE_TRACKS に分割する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で SUBSCRIBE_NAMESPACE (0x11) が SUBSCRIBE_NAMESPACE (0x50) と SUBSCRIBE_TRACKS (0x51) に分割された。
Subscribe Options フィールド (NamespaceSubscribeMode) が削除され、各メッセージの責務が明確化された。

> SUBSCRIBE_NAMESPACE Message {
>   Type (vi64) = 0x50,
>   Length (16),
>   Request ID (vi64),
>   Track Namespace Prefix (..),
>   Number of Parameters (vi64),
>   Parameters (..) ...
> }
>
> -- draft-ietf-moq-transport-18 §10.18

> SUBSCRIBE_TRACKS Message {
>   Type (vi64) = 0x51,
>   Length (16),
>   Request ID (vi64),
>   Track Namespace Prefix (..),
>   Number of Parameters (vi64),
>   Parameters (..) ...
> }
>
> -- draft-ietf-moq-transport-18 §10.19

> SUBSCRIBE_NAMESPACE requests namespace discovery: the publisher sends
> relevant NAMESPACE and NAMESPACE_DONE messages for namespaces
> matching the prefix.
>
> SUBSCRIBE_TRACKS requests track subscriptions: the publisher sends
> PUBLISH messages for tracks within matching namespaces.
>
> -- draft-ietf-moq-transport-18 §6.1

## 変更内容

### 1. メッセージタイプ定数を更新する (`src/message/types.ts`)

- `MessageType.SUBSCRIBE_NAMESPACE` を `0x11` から `0x50` に変更する
- `MessageType.SUBSCRIBE_TRACKS = 0x51` を新規追加する
- `NamespaceSubscribeMode` enum を削除する（Subscribe Options フィールド廃止に伴い）

### 2. SUBSCRIBE_TRACKS メッセージ型を追加する (`src/message/namespace.ts`)

- `SubscribeTracks` インターフェースを新設する（`SubscribeNamespace` と同構造で subscribeOptions なし）
- `encodeSubscribeTracksPayload()` 関数を新設する（subscribeOptions のエンコードを含まない）
- `decodeSubscribeTracksPayload()` 関数を新設する
- `SubscribeNamespace` インターフェースから `subscribeOptions` フィールドを削除する
- `encodeSubscribeNamespacePayload()` から subscribeOptions のエンコードを削除する
- `decodeSubscribeNamespacePayload()` から subscribeOptions のデコードを削除する

### 3. Session に subscribeTracks() API を追加する (`src/session.ts`)

- `Session` インターフェースに `subscribeTracks()` メソッドを追加する
- `SessionImpl` に `subscribeTracks()` を実装する（SUBSCRIBE_TRACKS メッセージを新規双方向ストリームで送信）
- `session.ts` のファイル先頭コメントの draft-17 → draft-18 参照を更新する

### 4. 応答ストリームループを分割する (`src/session.ts`)

- 現在の `startNamespaceStreamLoop()` を以下の 2 つに分割する:
  - `startNamespaceStreamLoop()`: SUBSCRIBE_NAMESPACE 応答として NAMESPACE/NAMESPACE_DONE のみ処理する
  - `startTracksStreamLoop()`: SUBSCRIBE_TRACKS 応答として PUBLISH_BLOCKED を処理する
- PUBLISH メッセージは SUBSCRIBE_TRACKS 応答ストリームではなく別 bidi ストリームで到着するため、
  `handleIncomingBidiStream()` で受信する

### 5. コールバックインターフェースを分割する (`src/session.ts`)

- `NamespaceSubscriptionCallbacks` を以下の 2 つに分割する:
  - `NamespaceSubscriptionCallbacks`: `onNamespace`, `onNamespaceDone`, `error`（SUBSCRIBE_NAMESPACE 用）
  - `TracksSubscriptionCallbacks`: `onPublishBlocked`, `error`（SUBSCRIBE_TRACKS 用）
- `namespaceSubscriptions` Map と `tracksSubscriptions` Map を独立管理する

### 6. 既存テストを更新する

- `src/message/namespace.prop.ts`: SubscribeNamespace から subscribeOptions を削除し、SubscribeTracks のテストを追加する
- `src/session.prop.ts`: 影響確認

## 該当箇所

| ファイル | 変更内容 |
|---|---|
| `src/message/types.ts:52-53` | `SUBSCRIBE_NAMESPACE` を `0x50` に変更、`SUBSCRIBE_TRACKS = 0x51` を追加 |
| `src/message/types.ts:260-276` | `NamespaceSubscribeMode` enum を削除する |
| `src/message/namespace.ts:67-94` | `SubscribeNamespace` から `subscribeOptions` を削除する |
| `src/message/namespace.ts:202-268` | `encodeSubscribeNamespacePayload`/`decodeSubscribeNamespacePayload` から subscribeOptions 処理を削除する |
| `src/message/namespace.ts` (新設) | `SubscribeTracks` 型、`encodeSubscribeTracksPayload`、`decodeSubscribeTracksPayload` を追加する |
| `src/session.ts:477-480` | コメントの draft-17 → draft-18 更新 |
| `src/session.ts:480-510` | `NamespaceSubscriptionCallbacks` から `onPublishBlocked` を削除し、`TracksSubscriptionCallbacks` を新設する |
| `src/session.ts:639-675` | `Session` インターフェースに `subscribeTracks()` を追加する |
| `src/session.ts:772-780` | `namespaceSubscriptions` と `tracksSubscriptions` の Map を分離する |
| `src/session.ts:1424-1511` | `subscribeNamespace()` の subscribeOptions 関連を削除する |
| `src/session.ts:1511-1701` | `startNamespaceStreamLoop()` を分割する |
| `src/session.ts` (新設) | `subscribeTracks()` と `startTracksStreamLoop()` を実装する |
| `src/message/namespace.prop.ts` | SubscribeNamespace テストから subscribeOptions を削除、SubscribeTracks テストを追加する |

## 期待される動作

- `session.subscribeNamespace(namespace, callbacks)` は NAMESPACE/NAMESPACE_DONE のみをコールバックで受け取る
- `session.subscribeTracks(namespace, callbacks)` は PUBLISH_BLOCKED をコールバックで受け取る
  - PUBLISH メッセージは新規 bidi ストリームで非同期に到着し、`handleIncomingBidiStream()` が処理する
- 両 API とも REQUEST_OK/REQUEST_ERROR を最初の応答として受け取る
- SUBSCRIBE_NAMESPACE と SUBSCRIBE_TRACKS の PREFIX_OVERLAP 空間は独立
- `NamespaceSubscribeMode` を参照するコードはビルドエラーになる（後方互換なし）

## テスト方針

### 単体テストの更新

- `namespace.prop.ts`: `namespaceSubscribeModeArb` を削除し、SubscribeNamespace テストから subscribeOptions 除去
- `namespace.prop.ts`: `decodeSubscribeNamespacePayload` で subscribeOptions がデコードされないことを検証
- `namespace.prop.ts`: `SubscribeTracks` のエンコード/デコード/フレーミングのラウンドトリップ PBT を追加
- `namespace.prop.ts`: `encodeSubscribeTracksPayload` で subscribeOptions がエンコードされないことを検証

### セッションテストの確認

- `session.prop.ts`: `subscribeTracks()` 関連のテストを追加する

## 影響範囲

- `MessageType.SUBSCRIBE_NAMESPACE` の値が `0x11` → `0x50` に変わる（ワイヤーフォーマット変更）
- `NamespaceSubscribeMode` enum が削除される（後方互換なし）
- `NamespaceSubscriptionCallbacks` から `onPublishBlocked` が削除される（後方互換なし）
- 新規 `TracksSubscriptionCallbacks` と `subscribeTracks()` API が追加される
- `src/index.ts` のエクスポートに `TracksSubscriptionCallbacks` を追加する必要がある

## 関連 issue

- 0179: SUBSCRIBE_NAMESPACE 応答ストリームで PUBLISH メッセージを受信する（0184 で SUBSCRIBE_TRACKS 側に移動するため、0179 と 0184 は相互作用あり。0184 を先に適用する）
- 0185: Required Request ID を削除する（SubscribeNamespace の requiredRequestIdDelta に影響）
- 0105: PUBLISH_NAMESPACE を専用ストリームで送受信する（18以降もこの設計は継続）
