# namespacePublication / namespaceSubscription に goaway コールバックを追加する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Completed: 2026-06-03

## 目的

PUBLISH / SUBSCRIBE / FETCH には `goawayCallback` が追加され、リクエストストリーム上の GOAWAY 受信時に newSessionUri がユーザーに通知されるようになったが、PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS のリクエストストリーム GOAWAY ではユーザーが newSessionUri を受け取る手段がない。

draft-ietf-moq-transport-18 §10.4 (GOAWAY):

> A GOAWAY MAY also be sent on a request stream to initiate migration
> of that individual request. Upon receiving a GOAWAY on a request stream,
> the endpoint SHOULD re-issue that specific request on a session at the
> specified URI (or the current session if no URI is provided)

## 優先度根拠

GOAWAY on request stream の機能が PUBLISH / SUBSCRIBE / FETCH に限定されており、namespace 系のリクエストではユーザーがマイグレーションを実行できない。仕様上すべてのリクエストストリームで GOAWAY が受信可能であり、一貫性のある対応が必要。

## 現状

- `src/session/bidi.ts:528-548`: `bidiReadRequestStreamMessages` の GOAWAY で publisher / subscriber / fetcher の goawayCallback が呼ばれる
- `src/session.ts:1842-1858`: namespace stream loop の GOAWAY では goawayCallback が呼ばれず、`pending.reject` のみ
- `src/session.ts:2290-2301`: namespace publication stream loop の GOAWAY でも goawayCallback が呼ばれず、`pending.reject` のみ
- `NamespaceSubscriptionCallbacks` / `TracksSubscriptionCallbacks` / `NamespacePublicationCallbacks` に `goaway` コールバックが定義されていない

## 設計方針

各コールバックインターフェースに `goaway?: (newSessionUri: string) => void` を追加し、GOAWAY 受信時に呼び出す。

```typescript
export interface NamespaceSubscriptionCallbacks {
  // ... existing callbacks
  goaway?: (newSessionUri: string) => void;
}
```

## 完了条件

- `NamespaceSubscriptionCallbacks` に `goaway` コールバックが追加されること
- `TracksSubscriptionCallbacks` に `goaway` コールバックが追加されること
- `NamespacePublicationCallbacks` に `goaway` コールバックが追加されること
- `startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop` の GOAWAY ハンドラでコールバックが呼ばれること
- テストが追加されること

## テスト戦略

各コールバックインターフェースの `goaway` がオプショナルであること（後方互換性維持）、GOAWAY 受信時にコールバックが呼ばれることをテストする。

## 解決方法

1. 各コールバックインターフェースに `goaway?: (newSessionUri: string) => void` を追加する
2. GOAWAY 受信箇所でコールバックを呼び出す
3. テストを追加する
