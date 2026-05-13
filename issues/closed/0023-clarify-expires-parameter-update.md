# EXPIRES パラメータ更新メカニズム明確化

## 概要

EXPIRES パラメータの更新メカニズムを明確化する。

## 参照

- draft-ietf-moq-transport-17 Section 9.8
- https://github.com/moq-wg/moq-transport/pull/1448

## 変更内容

- draft-17 で EXPIRES パラメータの更新方法が明確化された
- REQUEST_UPDATE でのパラメータ更新のセマンティクスが明確になった

## 影響範囲

- `src/message/parameter.ts`
- `src/session.ts`

## 実装方針

1. draft-17 Section 9.8 の EXPIRES パラメータ仕様を確認する
2. EXPIRES パラメータの更新処理が仕様に沿っているか確認する
3. 必要に応じて修正する
4. テストを更新する

## 解決方法

EXPIRES パラメータのエンコード・デコードは既に正しく実装されている。draft-17 の明確化はリレーとアプリケーション側のタイミングに関する考慮事項の追加であり、ワイヤフォーマットの変更はない。REQUEST_UPDATE での EXPIRES 送信は既存の Parameter 機構でサポート可能。コード変更不要。
