# DELIVERY_TIMEOUT の最小要件をプロパティにコピー

## 概要

DELIVERY_TIMEOUT の最小要件をパラメータからプロパティにコピーする。

## 参照

- draft-ietf-moq-transport-17 Section 11.4
- https://github.com/moq-wg/moq-transport/pull/1427

## 変更内容

- draft-17 で DELIVERY_TIMEOUT の最小要件が Parameter だけでなく Property としても定義された
- Object レベルでの配信タイムアウト制御が可能になった

## 影響範囲

- `src/extensions.ts`
- `src/message/parameter.ts`
- `src/dataStream.ts`

## 実装方針

1. draft-17 Section 11.4 の DELIVERY_TIMEOUT Property 仕様を確認する
2. DELIVERY_TIMEOUT を Property としてエンコード・デコードする処理を追加する
3. テストを追加する

## 解決方法

DELIVERY_TIMEOUT は既に Parameter (SUBSCRIBE 側、Parameter Type 0x02) と Track Extension Header/Property (PUBLISH 側、Extension Header ID 0x02) の両方でサポートされていた。min ネゴシエーションロジック (両方の非ゼロ値の最小値を使用) はリレーサーバー側の責務であり、クライアントライブラリ側では追加コード不要。コメントを draft-17 Section 11.1 参照に更新した。
