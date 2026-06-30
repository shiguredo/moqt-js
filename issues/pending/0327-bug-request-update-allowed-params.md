# REQUEST_UPDATE_ALLOWED_PARAMS に GROUP_ORDER / FILL_TIMEOUT が欠落

- Priority: High
- Created: 2026-06-30
- Completed:
- Model: Kimi Code CLI
- Branch: feature/fix-request-update-allowed-params
- Polished:

## 目的

`REQUEST_UPDATE_ALLOWED_PARAMS` に `GROUP_ORDER`（0x22）と `FILL_TIMEOUT`（0x0A）が含まれていないため、仕様上正当な REQUEST_UPDATE が `PROTOCOL_VIOLATION` と誤判定されるのを修正する。

## 優先度根拠

- draft-18 §10.9 に基づき、REQUEST_UPDATE は元のリクエストと同じパラメータを変更できる。
- `GROUP_ORDER` は SUBSCRIBE / FETCH の REQUEST_UPDATE で変更可能。
- `FILL_TIMEOUT` は FETCH の REQUEST_UPDATE で変更可能。
- 現状の単一 Set では元リクエスト型を区別できないため、FETCH 由来の REQUEST_UPDATE で FILL_TIMEOUT が拒否される。

## 現状

`src/message/parameterScope.ts:65-74` の `REQUEST_UPDATE_ALLOWED_PARAMS`:

```ts
export const REQUEST_UPDATE_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
  MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.FORWARD,
  MessageParameterType.SUBSCRIPTION_FILTER,
  MessageParameterType.NEW_GROUP_REQUEST,
  MessageParameterType.TRACK_NAMESPACE_PREFIX,
]);
```

`GROUP_ORDER`（0x22）と `FILL_TIMEOUT`（0x0A）が含まれていない。

### 仕様根拠

- §10.2.8: GROUP_ORDER MAY appear in a SUBSCRIBE, FETCH, REQUEST_UPDATE (for a subscription) message.
- §10.2.5: FILL_TIMEOUT MAY appear in a FETCH message.
- §10.9: REQUEST_UPDATE can modify parameters of the original request.

## 設計方針

- REQUEST_UPDATE の検証は元のリクエスト型（SUBSCRIBE / FETCH / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS）を考慮する必要がある。
- 単一の Set ではなく、元リクエスト型に応じた許可パラメータ集合を選択する方式に改める。
- または、REQUEST_UPDATE 送信時に元リクエスト型を保持し、受信側/送信側の検証で使用する。

## 完了条件

- SUBSCRIBE 由来の REQUEST_UPDATE で `GROUP_ORDER` が許可される。
- FETCH 由来の REQUEST_UPDATE で `FILL_TIMEOUT` と `GROUP_ORDER` が許可される。
- 元のリクエストに含まれていなかったパラメータを REQUEST_UPDATE で追加しようとした場合は拒否される（または仕様に応じた扱い）。
- 既存のテストが PASS し、新たに境界値テストが追加される。

## 解決方法

1. `src/message/parameterScope.ts` に元リクエスト型別の REQUEST_UPDATE 許可パラメータ集合を定義する。
2. `validateParameterScope()` の呼び出し元で元リクエスト型を渡せるようにインターフェースを調整する。
3. `src/session/bidi.ts` / `src/session.ts` の REQUEST_UPDATE 送信/受信処理を修正する。
4. テストを追加する。

## 該当箇所一覧

| ファイル | 変更内容 |
| --- | --- |
| `src/message/parameterScope.ts` | REQUEST_UPDATE の許可パラメータを元リクエスト型別に定義 |
| `src/session/bidi.ts` | REQUEST_UPDATE 受信時の検証を元リクエスト型に応じて切り替え |
| `src/session.ts` | REQUEST_UPDATE 送信時の検証を調整 |
