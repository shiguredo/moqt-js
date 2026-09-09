# END_OF_GROUP の FIN / Group 横断追跡を実装する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/add-end-of-group-tracking
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §11.3.1 / §12.1 は END_OF_GROUP ビットで Group 最大 Object を示し、それ以降の Object 受信を malformed 条件とする。現状は同一ストリーム内の検出のみで、FIN を跨ぐ判定と複数 Subgroup をまたぐ Group 単位の追跡が未実装である。

## 現状

- issue 0558 の適合監査 (D-8) で、`src/dataStream.ts` の `SubgroupHeader.endOfGroup` 公開と同一呼び出し内の検出までを実装した。
- FIN を `processSubgroupObjects` から観測できず、Group 単位の追跡にはセッション状態が必要。
- `src/session/stream.ts` の `processSubgroupObjects` は呼び出し単位の状態しか持たない。

## 設計方針

1. セッション (SubscriberImpl) に Group 単位の END_OF_GROUP 追跡状態を持たせる。
2. FIN 後の追加 Object と、END_OF_GROUP 済み Group の後続 Subgroup を malformed として検出する。
3. 仕様が「detected」と限定する条件は実装可能な範囲に留め、対象範囲をコメントで明記する。

## 完了条件

- END_OF_GROUP 後の FIN 跨ぎ / Group 横断の malformed が検出される。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §11.3.1 / §12.1
- 監査: issue 0558 の適合監査 (D-8)
