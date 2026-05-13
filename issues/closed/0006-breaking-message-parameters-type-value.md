# Message Parameters を Type-Value ペアエンコードに変更

## 概要

Message Parameters のエンコーディングを Key-Value-Pair から Type-Value ペアに変更する。

## 参照

- draft-ietf-moq-transport-17 Section 9.1
- https://github.com/moq-wg/moq-transport/pull/1462

## 変更内容

- draft-16 では Message Parameters は Key-Value-Pair 形式 (Key Length + Key + Value Length + Value) でエンコードされていた
- draft-17 では Type-Value ペア形式 (Type (varint) + Value Length + Value) に変更
- よりシンプルなエンコーディングになる

## 影響範囲

- `src/message/parameter.ts`
- `src/message/subscribe.ts`
- `src/message/publish.ts`
- `src/message/fetch.ts`

## 実装方針

1. draft-17 Section 9.1 の新しい Message Parameters エンコーディング仕様を確認する
2. `src/message/parameter.ts` のエンコード・デコード処理を Type-Value ペア形式に変更する
3. 関連するメッセージのテストを更新する

## 解決方法

現在のエンコード・デコード実装 (`encodeKeyValuePair`/`decodeKeyValuePair`) は既に draft-17 の `Type Delta (vi64) + Value (..)` 形式と互換。偶数型 (varint) / 奇数型 (length-prefixed) の区別は draft-17 のパラメータ定義と一致。コメントを draft-17 参照に更新。
