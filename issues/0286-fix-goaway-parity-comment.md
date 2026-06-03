# GOAWAY パリティチェックのコメントを修正する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18

## 目的

`handleGoaway` 内のパリティチェックコメントが「expected odd」としているが、クライアントが受信する GOAWAY の正しいパリティは even (クライアント生成 ID のパリティ)。コード動作は正しいがコメントが誤っている。

## 優先度根拠

コード動作に影響しないが、将来のメンテナに誤解を与える。

## 現状

`src/session.ts:3339`:
```typescript
`GOAWAY request ID parity mismatch: ${msg.requestId} (expected odd)`,
```

## 設計方針

- `expected odd` → `expected even` に修正する
- クライアント視点であることをコメントに明記する

## 完了条件

- コメントが正しいパリティ (even) を指している
