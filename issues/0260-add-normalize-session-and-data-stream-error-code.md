# normalizeSessionErrorCode と normalizeDataStreamErrorCode を追加する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Relations: #0268 (Set ベース実装へのリファクタリング)

## 目的

`normalizeRequestErrorCode` / `normalizePublishDoneCode` のみが定義されており、`SessionErrorCode` と `DataStreamErrorCode` 用の normalize 関数が存在しない。Grease 仕様では「すべてのエラーコンテキスト」で未知エラーコードを INTERNAL_ERROR として扱うことが MUST とされている。

draft-ietf-moq-transport-18 §14 (Grease):

> Receipt of an unknown error code in any error context (Session Termination,
> REQUEST_ERROR, PUBLISH_DONE, or Data Stream Reset) MUST be treated as
> equivalent to INTERNAL_ERROR for that context.

## 優先度根拠

Grease 値の受信時に Session Termination や Data Stream Reset で適切なエラーハンドリングが行われない。仕様 MUST 違反であり、未知エラーコードの正規化が行われないと予期しない動作を引き起こす可能性がある。

## 現状

- `src/error.ts:81-86`: `normalizeRequestErrorCode` が定義済み
- `src/error.ts:92-97`: `normalizePublishDoneCode` が定義済み
- `normalizeSessionErrorCode` と `normalizeDataStreamErrorCode` は未定義
- `SessionErrorCode` の定数リストと `DataStreamErrorCode` の定数リストは存在するが、受信パスでの正規化が行われていない

## 設計方針

既存の normalize 関数と同じパターンで追加する。

```typescript
const SESSION_ERROR_CODE_SET = new Set(Object.values(SessionErrorCode));

export function normalizeSessionErrorCode(code: number): SessionErrorCode {
  if (SESSION_ERROR_CODE_SET.has(code)) {
    return code as SessionErrorCode;
  }
  return SessionErrorCode.INTERNAL_ERROR;
}

const DATA_STREAM_ERROR_CODE_SET = new Set(Object.values(DataStreamErrorCode));

export function normalizeDataStreamErrorCode(code: number): DataStreamErrorCode {
  if (DATA_STREAM_ERROR_CODE_SET.has(code)) {
    return code as DataStreamErrorCode;
  }
  return DataStreamErrorCode.INTERNAL_ERROR;
}
```

## 完了条件

- `normalizeSessionErrorCode` / `normalizeDataStreamErrorCode` が `src/error.ts` に追加され、`src/index.ts` から公開されること
- 既存の `normalizeRequestErrorCode` / `normalizePublishDoneCode` と同様の Set ベース実装であること
- 未知の Session Termination エラーコード受信時に INTERNAL_ERROR に正規化されること
- 未知の Data Stream Reset エラーコード受信時に INTERNAL_ERROR に正規化されること

## テスト戦略

`src/error.test.ts` に以下を追加:

1. `normalizeSessionErrorCode`: 既知コード → 同一コード、未知コード → INTERNAL_ERROR
2. `normalizeDataStreamErrorCode`: 既知コード → 同一コード、未知コード → INTERNAL_ERROR

## 解決方法

1. `src/error.ts` に `normalizeSessionErrorCode` と `normalizeDataStreamErrorCode` を追加する
2. エラーコード受信パスを特定し、正規化を適用する
3. `src/error.test.ts` にテストを追加する
4. `src/index.ts` から公開する
