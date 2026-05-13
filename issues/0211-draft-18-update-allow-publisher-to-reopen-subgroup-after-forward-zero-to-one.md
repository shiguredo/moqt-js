# REQUEST_UPDATE で forward 0→1 後の Subgroup 再オープンを許可する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で REQUEST_UPDATE により forward が 0→1 に戻った場合、
publisher は以前に閉じた Subgroup を再オープンしてよいと明示された。
moqt-js は Publisher として動作する場合、closedSubgroups 追跡にこの例外を組み込む必要がある。

しかし moqt-js の現在の実装では closedSubgroups 追跡は未実装であり、
0178 で言及されている「閉じた Subgroup への送信禁止」も実装されていない。
したがって、この issue はコメント更新で対応し、Subgroup 再オープン対応は将来の実装時に考慮する。

## RFC 参照

draft-ietf-moq-transport-18 §11.4.3 (Closing Subgroup Streams):

> When a publisher receives a REQUEST_UPDATE that changes the Forward
> State from 0 to 1, it MAY reopen subgroups previously closed under
> this subscription.

draft-ietf-moq-transport-18 A.1: "Allow publisher to reopen subgroup after REQUEST_UPDATE forward 0→1 (#1583)"

## 変更内容

1. `src/session.ts` の TODO コメント (Closed Subgroup Tracking) に、forward 0→1 時の再オープン許可の例外を追記する

## 該当ファイル

| ファイル | 行番号 | 変更内容 |
| --- | --- | --- |
| `src/session.ts` | 828-838 | TODO コメントに forward 0→1 → Subgroup 再オープン許可の例外を追記する |

## 期待される動作

1. 現在は closedSubgroups 追跡が未実装のため、動作に変更はない
2. 将来 closedSubgroups 追跡を実装する際、forward 0→1 時に対応 Subgroup の closed エントリをクリアする処理を追加する

## テスト方針

- 既存テストの変更は不要 (未実装機能のコメント更新のみ)

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
