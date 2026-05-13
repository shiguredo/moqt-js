# Track Alias の一意性明確化

## 概要

Track Alias の一意性に関する要件を明確化する。

## 参照

- draft-ietf-moq-transport-17 Section 2.4
- https://github.com/moq-wg/moq-transport/pull/1418

## 変更内容

- draft-17 で Track Alias の一意性に関する要件が明確化された
- 同一セッション内での Track Alias の重複を禁止する条件が定義された

## 影響範囲

- `src/session.ts`
- `src/subscriber.ts`
- `src/publisher.ts`

## 実装方針

1. draft-17 Section 2.4 の Track Alias 一意性仕様を確認する
2. Track Alias の一意性チェック処理を確認・強化する
3. テストを追加する

## 解決方法

Track Alias の一意性は既に以下で保証されている:

- Publisher 側: `nextTrackAlias++` による自動インクリメントで割り当て
- Subscriber 側: `subscribersByAlias` Map により Track Alias → Subscriber の一意マッピングを管理
  コード変更不要。
