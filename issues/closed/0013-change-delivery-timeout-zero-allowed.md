# DELIVERY_TIMEOUT=0 を許可（タイムアウトなし）

## 概要

DELIVERY_TIMEOUT の値として 0 を許可し、タイムアウトなしを意味するようにする。

## 参照

- draft-ietf-moq-transport-17 Section 11.4
- https://github.com/moq-wg/moq-transport/pull/1450

## 変更内容

- draft-16 では DELIVERY_TIMEOUT の値 0 は無効だった
- draft-17 では DELIVERY_TIMEOUT の値 0 を「タイムアウトなし」として許可する
- 0 を指定すると Object の配信にタイムアウトを設けない

## 影響範囲

- `src/message/parameter.ts`
- `src/session.ts`
- `src/dataStream.ts`

## 実装方針

1. DELIVERY_TIMEOUT のバリデーションを更新し、0 を有効な値として受け入れる
2. 0 の場合はタイムアウト処理をスキップするようにする
3. テストを更新する

## 解決方法

`session.ts` の publish() と subscribe() で DELIVERY_TIMEOUT=0 を拒否していたバリデーション (`throw new Error("DELIVERY_TIMEOUT=0 is not allowed")`) を削除した。0 はタイムアウトなしとして許可される。タイムアウト処理自体はサーバー側の責務。
