# PublishDoneStatusCode と PublishDoneCode の重複定義を整理する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/refactor-dedup-publish-done-code
- Polished: 2026-06-03

## 目的

`PublishDoneStatusCode` (`src/message/types.ts`) と `PublishDoneCode` (`src/error.ts`) が同一の値を持つ定数オブジェクトとして重複定義されている。コードの保守性向上のため一本化する。

## 現状

`src/message/types.ts:250-261` (`PublishDoneStatusCode`):

```typescript
export const PublishDoneStatusCode = {
  INTERNAL_ERROR: 0x0,
  UNAUTHORIZED: 0x1,
  ...
  MALFORMED_TRACK: 0x12,
} as const;
```

`src/error.ts:101-112` (`PublishDoneCode`):

```typescript
export const PublishDoneCode = {
  INTERNAL_ERROR: 0x0,
  UNAUTHORIZED: 0x1,
  ...
  MALFORMED_TRACK: 0x12,
} as const;
```

両者は同一の 10 個のコードを定義している。

## 設計方針

`PublishDoneCode` を削除し、`PublishDoneStatusCode` に統一する。またはその逆。影響範囲を調査し、参照箇所をすべて置き換える。

## 影響範囲

- `src/message/types.ts`: 維持する
- `src/error.ts`: `PublishDoneCode` を削除し、`PublishDoneStatusCode` を import して使用する
- `src/error.ts` 内部の `PublishDoneCode` 参照箇所

## 完了条件

- `PublishDoneStatusCode` と `PublishDoneCode` の重複が解消されている
- 全ての参照が一本化されている
- `vp run test` 全パス
- `vp run build` 成功
