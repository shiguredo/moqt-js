# Fetch 先頭オブジェクトに PRIORITY_PRESENT を MUST で要求している

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18

## 目的

`decodeFetchObjectFields` で先頭オブジェクトに PRIORITY_PRESENT フラグを必須とし、無ければ ProtocolViolationError としているが、仕様上先頭オブジェクトに MUST なのは Group ID Delta と Object ID Delta のみで、Priority は任意である。

## 優先度根拠

Priority なしの Fetch 先頭オブジェクトを不正に拒否してしまう相互運用性問題。

## 現状

`src/dataStream.ts:1430-1433`:
```typescript
if ((fields.flags & 0x10) === 0) {
  throw new ProtocolViolationError(
    "protocol violation: fetch first object must have priority present"
  );
}
```

draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
> The first Object MUST include a Group ID Delta and Object ID Delta,
> and these values are the absolute Group ID and Object ID.

PRIORITY_PRESENT は MUST 要件に含まれていない。

## 設計方針

- 先頭オブジェクトの PRIORITY_PRESENT チェックを緩和し、任意にする
- PRIORITY_PRESENT がない場合は Publisher Priority にデフォルト値 (128) を使用する

## 完了条件

- Priority なしの Fetch 先頭オブジェクトが正常に処理される
- テストが修正されている
