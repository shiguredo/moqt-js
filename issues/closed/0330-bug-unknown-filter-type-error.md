# 未知の Subscription Filter Type 受信時に ProtocolViolationError を throw しない

- Priority: Medium
- Created: 2026-06-30
- Completed: 2026-07-23
- Model: Kimi Code CLI
- Branch: feature/fix-unknown-filter-type-error
- Polished: 2026-07-23

## 目的

draft-18 §5.1.2 に基づき、未知の Subscription Filter Type を受信した場合に `PROTOCOL_VIOLATION` でセッションを閉じられるようにする。

## 優先度根拠

- draft-18 §5.1.2: "An endpoint that receives a filter type other than the above MUST close the session with PROTOCOL_VIOLATION." — 任意のエンドポイントに対する MUST 要件。SUBSCRIBE / PUBLISH_OK / REQUEST_UPDATE のいずれで受信した場合も対象。
- 現状は汎用 `Error` が throw されるため、`toProtocolViolationSessionError`（`src/session/errors.ts`）が `instanceof ProtocolViolationError` で判定する際に `null` を返し、PROTOCOL_VIOLATION として処理されない。

## 現状

`src/message/parameter.ts:924` の `decodeSubscriptionFilter()` の `switch` 文 `default` ケース:

```ts
throw new Error(`Unknown filter type: ${filterType}`);
```

`toProtocolViolationSessionError`（`src/session/errors.ts`）は `ProtocolViolationError` のインスタンスのみを `SessionError(PROTOCOL_VIOLATION)` に変換する。plain `Error` は `null` を返すため、上位ループで PROTOCOL_VIOLATION として処理されず、エラーが黙って握り潰されるか、汎用エラーとして処理される。

`decodeSubscriptionFilterParameter()`（parameter.ts:947）は内部で `decodeSubscriptionFilter()` を呼び出しているため、`decodeSubscriptionFilter()` の修正で自動的に伝播する。`decodeSubscriptionFilterParameter()` 自体の `Invalid parameter type` ガード（parameter.ts:944-946）は内部的な API ガードであり、リモートピアからのプロトコル違反とは性質が異なるため、変更しない。

## 設計方針

- `decodeSubscriptionFilter()` の `default` ケースを `ProtocolViolationError` に変更する。
- `decodeSubscriptionFilterParameter()` の `Invalid parameter type` ガードは内部的な API ガードのため変更しない。
- 既存の `toProtocolViolationSessionError` 経路で自動的に PROTOCOL_VIOLATION セッション終了となる。

## 完了条件

- 未知の Filter Type を受信した場合、`ProtocolViolationError` が throw される。
- `toProtocolViolationSessionError` 経路で PROTOCOL_VIOLATION としてセッションが閉じられる。
- 既存テスト "無効なフィルタタイプでエラー"（`parameter.test.ts:28-30`）を `ProtocolViolationError` のインスタンス検証に更新する。
- 未知 Filter Type の `ProtocolViolationError` 検証テストが追加される。

## 解決方法

1. `src/message/parameter.ts` の `decodeSubscriptionFilter()` の `default` ケースで `Error` を `ProtocolViolationError` に置き換える。
2. `src/message/parameter.test.ts` の既存テスト "無効なフィルタタイプでエラー" を `ProtocolViolationError` のインスタンス検証に更新する。

## reopened にする理由

polish-issue による磨き上げが完了したため。仕様引用の検証・設計方針の確定・完了条件の具体化を実施済み。
