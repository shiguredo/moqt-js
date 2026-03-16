# Properties を mutable リストまたは Immutable Properties 内に配置可能

## 概要

Properties を mutable リストまたは Immutable Properties 内のどちらにも配置可能であることを明確化する。

## 参照

- draft-ietf-moq-transport-17 Section 11
- https://github.com/moq-wg/moq-transport/pull/1442

## 変更内容

- draft-17 で Properties を mutable リストに含めるか、Immutable Properties 内に含めるかを選択できることが明確化された
- 各 Property の mutability に応じて適切な場所に配置する

## 影響範囲

- `src/extensions.ts`
- `src/dataStream.ts`

## 実装方針

1. draft-17 Section 11 の Properties 配置仕様を確認する
2. Property の mutability に基づいた配置ロジックを実装する
3. テストを追加する

## 解決方法

既存の `extensions.ts` の `ImmutableExtensions` と `encodeExtensionHeaders`/`decodeExtensionHeaders` が mutable リストと Immutable Extensions の両方をサポートしている。Property を mutable リストに含めるか Immutable Extensions 内に含めるかは呼び出し側で選択可能な設計になっている。コード変更不要。
