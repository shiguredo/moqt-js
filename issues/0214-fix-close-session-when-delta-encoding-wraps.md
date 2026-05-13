# delta encoding がラップした場合にセッションを閉じる

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Fetch / Subgroup の delta encoding (Object ID delta, Group ID delta) が
varint 範囲を超えてラップアラウンドする場合、セッションを PROTOCOL_VIOLATION で閉じると明示された。
moqt-js は delta デコード時に累積結果のラップを検出してセッションを閉じる必要がある。

## draft-18 参照

- draft-ietf-moq-transport-18 §11.4.2 Subgroup Header
- draft-ietf-moq-transport-18 §11.4.4 Fetch Header
- moq-wg/moq-transport#1560

## 影響範囲

- Subgroup / Fetch stream デコーダの累積 ID 計算
- PROTOCOL_VIOLATION 経路
- 関連 PBT
