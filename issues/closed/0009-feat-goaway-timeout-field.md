# GOAWAY に Timeout フィールド追加

## 概要

GOAWAY メッセージに Timeout フィールドを追加する。

## 参照

- draft-ietf-moq-transport-17 Section 9.22
- https://github.com/moq-wg/moq-transport/pull/1497

## 変更内容

- draft-16 では GOAWAY は New Session URI のみを含んでいた
- draft-17 では Timeout フィールドが追加され、接続終了までの猶予時間をミリ秒単位で指定可能になった
- Timeout 値が 0 の場合は即時切断を意味する

## 影響範囲

- `src/message/session.ts`
- `src/session.ts`

## 実装方針

1. draft-17 Section 9.22 の GOAWAY メッセージ仕様を確認する
2. GOAWAY メッセージに Timeout フィールドを追加する
3. エンコード・デコード処理を更新する
4. セッション側で Timeout に基づいた graceful shutdown を実装する
5. テストを更新する

## 解決方法

`Goaway` インターフェースに `timeout: bigint` フィールドを追加。エンコード・デコード処理を更新し、`session.ts` の `goaway()` メソッドに `timeout` パラメータを追加。PBT テストも timeout を含むラウンドトリップテストに更新。

変更ファイル:

- `src/message/session.ts`: Goaway インターフェース、エンコード・デコード
- `src/message/session.prop.ts`: PBT テスト
- `src/session.ts`: goaway() メソッド、handleGoaway()
