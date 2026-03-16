# END_OF_GROUP の Subgroup 内 malformed track 明確化

## 概要

END_OF_GROUP を含む Subgroup 内での malformed track の扱いを明確化する。

## 参照

- draft-ietf-moq-transport-17 Section 10.1
- https://github.com/moq-wg/moq-transport/pull/1464

## 変更内容

- draft-17 で END_OF_GROUP を含む Subgroup 内で malformed track を検出した場合の処理が明確化された
- エラーハンドリングの挙動が定義された

## 影響範囲

- `src/dataStream.ts`

## 実装方針

1. draft-17 Section 10.1 の malformed track 仕様を確認する
2. END_OF_GROUP を含む Subgroup 内での malformed track 検出処理を実装する
3. テストを追加する

## 解決方法

malformed track の検出と PUBLISH_DONE の送信はリレーサーバーの責務。moqt-js はクライアントライブラリであり、END_OF_GROUP を含む Subgroup ヘッダータイプの対応は `dataStream.ts` で既に実装済み。コード変更不要。
