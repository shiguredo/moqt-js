# Subscription Filter の EndGroup をデルタに変更

## 概要

Subscription Filter の EndGroup フィールドを絶対値からデルタエンコードに変更する。

## 参照

- draft-ietf-moq-transport-17 Section 9.8
- https://github.com/moq-wg/moq-transport/pull/1470

## 変更内容

- draft-16 では Subscription Filter の EndGroup は絶対値 (Group ID) で指定していた
- draft-17 では EndGroup をデルタ値に変更
- StartGroup からの差分で EndGroup を表現する

## 影響範囲

- `src/message/subscribe.ts`
- `src/subscriber.ts`

## 実装方針

1. draft-17 Section 9.8 の Subscription Filter 仕様を確認する
2. EndGroup のエンコードをデルタ方式に変更する
3. デコード時に StartGroup + Delta で EndGroup を算出するようにする
4. テストを更新する

## 解決方法

`SubscriptionFilter` の `AbsoluteRange` 型の `endGroup: bigint` を `endGroupDelta: bigint` にリネームした。エンコード・デコード処理はワイヤ上の値がデルタ値であることを反映。PBT テストも `endGroupDelta` に更新。

変更ファイル:

- `src/message/parameter.ts`: 型定義、エンコード、デコード
- `src/message/parameter.prop.ts`: テスト
