# PUBLISH メッセージの Parameter Scope 検証が未実装

- Priority: High
- Created: 2026-06-30
- Completed: 2026-07-23
- Model: Kimi Code CLI
- Branch: feature/fix-publish-parameter-scope
- Polished: 2026-07-23

## 目的

PUBLISH メッセージに対して Parameter Scope 検証を実装し、許可されていないパラメータが含まれている場合に `PROTOCOL_VIOLATION` でセッションを閉じる。

## 優先度根拠

- draft-18 §10.2.1: "Each Message Parameter definition indicates the message types in which it can appear. If it appears in some other type of message, the receiving endpoint MUST close the connection with a PROTOCOL_VIOLATION." — 許可されていないメッセージ型にパラメータが出現した場合の PROTOCOL_VIOLATION MUST 要件。
- `parameterScope.ts` には SUBSCRIBE / FETCH / REQUEST_UPDATE 等の許可集合があるが、PUBLISH 用が欠落している。
- PUBLISH 受信時に `validateParameterScope()` が呼ばれていないため、不正なパラメータを含む PUBLISH が黙って受理される。

## 現状

`src/message/parameterScope.ts` には `PUBLISH_ALLOWED_PARAMS` が定義されていない。

`src/session.ts` の PUBLISH 受信処理（`decodePublishPayload` 呼び出し直後、約 4008 行目以降のインラインブロック）で `validateParameterScope()` が呼ばれていない。

PUBLISH メッセージに許可されるパラメータ（§10.2 各節で PUBLISH への出現が明示されているもの）:

- `AUTHORIZATION_TOKEN`（0x03）— §10.2.2: "It MAY appear in a PUBLISH, SUBSCRIBE, REQUEST_UPDATE, ..."
- `EXPIRES`（0x08）— §10.2.10: "It MAY appear in SUBSCRIBE_OK, PUBLISH, PUBLISH_OK, or REQUEST_UPDATE_OK."
- `LARGEST_OBJECT`（0x09）— §10.2.11: "It MAY appear in SUBSCRIBE_OK, PUBLISH, REQUEST_UPDATE_OK, or TRACK_STATUS_OK."
- `FORWARD`（0x10）— §10.2.12: "It MAY appear in SUBSCRIBE, REQUEST_UPDATE (for a subscription), PUBLISH, PUBLISH_OK and SUBSCRIBE_TRACKS."

注意: `GROUP_ORDER`（0x22）は §10.2.8 で "It MAY appear in a SUBSCRIBE, PUBLISH_OK, or FETCH." と定義されており、PUBLISH には許可されていない。PUBLISH に GROUP_ORDER が含まれる場合は PROTOCOL_VIOLATION でセッションを閉じるのが正しい挙動である。

### 送信側との非対称性

送信側の `buildPublishParameters`（`src/session/params.ts`）は現在 EXPIRES と FORWARD の 2 種のみ構築する。受信側の許可リストには AUTHORIZATION_TOKEN と LARGEST_OBJECT も含まれる（仕様上正しい）。送信しないパラメータを受信許可に含めるのは、ピアが送信する可能性があるためであり、設計上正しい非対称性である。

## 設計方針

- `src/message/parameterScope.ts` に `PUBLISH_ALLOWED_PARAMS` を追加する。許可セットは AUTHORIZATION_TOKEN / EXPIRES / LARGEST_OBJECT / FORWARD の 4 個。
- `src/session.ts` の PUBLISH 受信処理で `decodePublishPayload` 成功直後、`matchPublishToSubscription` 呼び出し前に `validateParameterScope(decodedPublish.parameters, PUBLISH_ALLOWED_PARAMS, "PUBLISH", ...)` を呼ぶ。
- 既存の呼び出しパターン（`session.ts` の SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK、`bidi.ts` の PUBLISH_OK 等）を踏襲する。
- Track Properties は `decodeProperties()` で処理されるため、Parameter Scope とは別に扱う。

## 完了条件

- PUBLISH メッセージに許可されていないパラメータ（例: GROUP_ORDER、SUBSCRIBER_PRIORITY 等）が含まれている場合、`PROTOCOL_VIOLATION` でセッションを閉じる。
- 許可された 4 パラメータ（AUTHORIZATION_TOKEN / EXPIRES / LARGEST_OBJECT / FORWARD）は通常通り処理される。
- 既存のテストが PASS し、PUBLISH Parameter Scope 検証のテストが追加される。

## 解決方法

1. `src/message/parameterScope.ts` に `PUBLISH_ALLOWED_PARAMS`（AUTHORIZATION_TOKEN / EXPIRES / LARGEST_OBJECT / FORWARD の 4 個）を追加する。
2. `src/session.ts` の PUBLISH 受信処理（`decodePublishPayload` 成功直後）に `validateParameterScope()` を組み込む。既存の SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK の呼び出しパターンを参照。
3. PUBLISH 受信時の Parameter Scope 検証テストを追加する（許可パラメータ通過、不許可パラメータで PROTOCOL_VIOLATION）。

## reopened にする理由

polish-issue による磨き上げが完了したため。仕様引用の検証・設計方針の確定・完了条件の具体化を実施済み。
