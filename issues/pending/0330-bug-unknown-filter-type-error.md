# 未知の Subscription Filter Type 受信時に ProtocolViolationError を throw しない

- Priority: Medium
- Created: 2026-06-30
- Completed:
- Model: Kimi Code CLI
- Branch: feature/fix-unknown-filter-type-error
- Polished:

## 目的

draft-18 §5.1.2 に基づき、未知の Subscription Filter Type を受信した場合に `PROTOCOL_VIOLATION` でセッションを閉じられるようにする。

## 優先度根拠

- draft-18 準拠の MUST 要件。
- 現状は汎用 `Error` が throw されるため、上位ループで `PROTOCOL_VIOLATION` として扱われない可能性がある。

## 現状

`src/message/parameter.ts:924`:

```ts
throw new Error(`Unknown filter type: ${filterType}`);
```

§5.1.2 では "If a subscriber receives a SUBSCRIBE with an unknown Filter Type, it MUST close the session with a PROTOCOL_VIOLATION." と定められている。

## 設計方針

- `decodeSubscriptionFilter()` の `default` ケースを `ProtocolViolationError` に変更する。
- 必要に応じて `decodeSubscriptionFilterParameter()` も同様に調整する。

## 完了条件

- 未知の Filter Type を受信した場合、`ProtocolViolationError` が throw される。
- 上位ループで `PROTOCOL_VIOLATION` としてセッションが閉じられる。
- テストが追加される。

## 解決方法

1. `src/message/parameter.ts` の `decodeSubscriptionFilter()` で `Error` を `ProtocolViolationError` に置き換える。
2. `src/message/parameter.test.ts` にテストを追加する。

## 該当箇所一覧

| ファイル | 変更内容 |
| --- | --- |
| `src/message/parameter.ts` | 未知 Filter Type のエラーを `ProtocolViolationError` に変更 |
| `src/message/parameter.test.ts` | テスト追加 |
