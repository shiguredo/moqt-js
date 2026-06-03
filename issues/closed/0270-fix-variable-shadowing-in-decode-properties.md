# decodeProperties の内側変数 length が外側スコープの length をシャドウイングしているのを修正する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Completed: 2026-06-03
- Branch: feature/draft-18
- Polished: 2026-06-03
- Relations: #0256 (IMMUTABLE_PROPERTIES 再帰チェック修正と同時に対応可能)

## 目的

`src/properties.ts:679` の内側 `const [length, lengthLen]` が外側スコープの `length` (line 647 で宣言) をシャドウイングしている。動作上は正しいが、可読性の観点から別名が推奨される。

## 優先度根拠

軽微な可読性改善。変数名の衝突は将来のリファクタリング時の誤りの原因になりうる。

## 現状

```typescript
// outer scope:
const [length, lengthLen] = decodeVarint(extData.subarray(offset + deltaIdLen));
// ...
// inner scope (inside while loop):
const [length, lengthLen] = decodeVarint(extData.subarray(innerOffset + deltaIdLen));
```

内側 `length` が外側 `length` をシャドウイングしている。

## 設計方針

内側の変数名を `innerLength`, `innerLengthLen` に改名する。

```typescript
const [innerLength, innerLengthLen] = decodeVarint(extData.subarray(innerOffset + deltaIdLen));
innerOffset += deltaIdLen + innerLengthLen + Number(innerLength);
```

## 完了条件

- 内側変数名が外側と衝突しない名前に変更されていること
- テストが引き続きパスすること

## 解決方法

1. `src/properties.ts:679` の内側 `length` と `lengthLen` を `innerLength` と `innerLengthLen` に改名する
2. 使用箇所 (line 681) も追従修正する
