# PUBLISH メッセージの Parameter Scope 検証が未実装

- Priority: High
- Created: 2026-06-30
- Completed:
- Model: Kimi Code CLI
- Branch: feature/fix-publish-parameter-scope
- Polished:

## 目的

PUBLISH メッセージに対して Parameter Scope 検証を実装し、許可されていないパラメータが含まれている場合に `PROTOCOL_VIOLATION` でセッションを閉じる。

## 優先度根拠

- draft-18 §10.2.1 の MUST 要件: "An endpoint that receives a parameter in a context where it is not allowed MUST close the connection with a PROTOCOL_VIOLATION."
- `parameterScope.ts` には SUBSCRIBE / FETCH / REQUEST_UPDATE 等の許可集合があるが、PUBLISH 用が欠落している。

## 現状

`src/message/parameterScope.ts` には `PUBLISH_ALLOWED_PARAMS` が定義されていない。

`src/session.ts` の `handleIncomingPublishStream()` 等で PUBLISH メッセージを受信した際、`validateParameterScope()` が呼ばれていない。

PUBLISH メッセージに許可されるパラメータ（§10.2 各節）:

- `AUTHORIZATION_TOKEN`（0x03）
- `EXPIRES`（0x08）
- `LARGEST_OBJECT`（0x09）
- `FORWARD`（0x10）
- `GROUP_ORDER`（0x22）

## 設計方針

- `src/message/parameterScope.ts` に `PUBLISH_ALLOWED_PARAMS` を追加する。
- `src/session.ts` の PUBLISH 受信処理で `validateParameterScope(decodedPublish.parameters, PUBLISH_ALLOWED_PARAMS, ...)` を呼ぶ。
- Track Properties は `decodeProperties()` で処理されるため、Parameter Scope とは別に扱う。

## 完了条件

- PUBLISH メッセージに許可されていないパラメータが含まれている場合、`PROTOCOL_VIOLATION` でセッションを閉じる。
- 許可されたパラメータは通常通り処理される。
- テストが追加される。

## 解決方法

1. `src/message/parameterScope.ts` に `PUBLISH_ALLOWED_PARAMS` を追加する。
2. `src/session.ts` の PUBLISH 受信処理に `validateParameterScope()` を組み込む。
3. `src/session/bidi.test.ts` 等にテストを追加する。

## 該当箇所一覧

| ファイル                        | 変更内容                                  |
| ------------------------------- | ----------------------------------------- |
| `src/message/parameterScope.ts` | `PUBLISH_ALLOWED_PARAMS` の追加           |
| `src/session.ts`                | PUBLISH 受信時の Parameter Scope 検証追加 |
