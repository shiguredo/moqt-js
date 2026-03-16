# Immutable Property の保存要件明確化

## 概要

Immutable Property の保存要件を明確化する。

## 参照

- draft-ietf-moq-transport-17 Section 11.6
- https://github.com/moq-wg/moq-transport/pull/1441

## 変更内容

- draft-17 で Immutable Property の保存要件が明確化された
- リレーや中間ノードが Immutable Property をどのように保持・転送すべきかが定義された

## 影響範囲

- `src/extensions.ts`
- `src/dataStream.ts`

## 実装方針

1. draft-17 Section 11.6 の Immutable Property 保存要件を確認する
2. Immutable Property の保持・転送処理を仕様に沿って実装する
3. テストを追加する

## 解決方法

Immutable Property の保存・転送はリレーサーバーの責務。moqt-js はクライアントライブラリであり、`ImmutableExtensions` のエンコード・デコードは既に `extensions.ts` で実装済み。コード変更不要。
