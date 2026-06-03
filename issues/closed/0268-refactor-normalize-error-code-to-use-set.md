# normalizeRequestErrorCode / normalizePublishDoneCode を Set ベースの O(1) 実装に改善する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Relations: #0260 (新規追加の normalizeSessionErrorCode / normalizeDataStreamErrorCode も Set ベースで実装すること)

- Polished: 2026-06-03
- Completed: 2026-06-03

## 目的

`normalizeRequestErrorCode` と `normalizePublishDoneCode` は `Object.values().includes()` による O(n) 配列走査で実装されている。呼び出し頻度は低いため実用上の問題はないが、「これはメンバーシップチェックである」という意図を Set で表現するほうが明確で、パフォーマンス面でも優れている。

## 優先度根拠

軽微な実装改善。Premature Optimization ではないが、意図の明確さと性能の両面で改善される。

## 現状

```typescript
export function normalizeRequestErrorCode(code: number): RequestErrorCode {
  if (Object.values(RequestErrorCode).includes(code as RequestErrorCode)) {
    return code as RequestErrorCode;
  }
  return RequestErrorCode.INTERNAL_ERROR;
}
```

## 設計方針

モジュールレベル定数として Set を事前計算する。

```typescript
const REQUEST_ERROR_CODE_SET: Set<number> = new Set(Object.values(RequestErrorCode));

export function normalizeRequestErrorCode(code: number): RequestErrorCode {
  if (REQUEST_ERROR_CODE_SET.has(code)) {
    return code as RequestErrorCode;
  }
  return RequestErrorCode.INTERNAL_ERROR;
}
```

`normalizePublishDoneCode` も同様に修正する。
新規追加予定の `normalizeSessionErrorCode` / `normalizeDataStreamErrorCode` (issue #0260) も Set ベースで実装する。

## 完了条件

- `normalizeRequestErrorCode` が Set ベースで実装されていること
- `normalizePublishDoneCode` が Set ベースで実装されていること
- 既存テストが引き続きパスすること

## 解決方法

1. `src/error.ts` に `REQUEST_ERROR_CODE_SET` と `PUBLISH_DONE_CODE_SET` 定数を追加する
2. normalize 関数を Set.has() に置き換える
3. テストが通ることを確認する
