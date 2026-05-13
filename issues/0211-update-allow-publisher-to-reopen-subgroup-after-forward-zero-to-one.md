# REQUEST_UPDATE で forward 0→1 後の Subgroup 再オープンを許可する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で REQUEST_UPDATE により forward が 0 → 1 に戻った場合、
publisher は以前に閉じた Subgroup を再オープンしてよいと明示された。
0178 で実装した「閉じた Subgroup への送信禁止」と例外的に整合させる必要がある。
forward 0→1 遷移時に該当する closedSubgroups エントリをクリアする。

## draft-18 参照

- draft-ietf-moq-transport-18 §11.4.3 Closing Subgroup Streams
- draft-ietf-moq-transport-18 §10.9.1 Updating Subscriptions
- moq-wg/moq-transport#1583

## 影響範囲

- `src/session.ts` の `closedSubgroups` 管理 (0178 で導入)
- REQUEST_UPDATE 受信時の forward 状態遷移ハンドラ
