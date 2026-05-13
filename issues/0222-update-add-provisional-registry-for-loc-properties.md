# LOC Properties 用の provisional registry を追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で LOC (Location 構造体) Properties 用の provisional IANA registry が追加された。
将来的に LOC 拡張で利用される property の登録枠組みが整備される。
moqt-js は LOC Properties を扱う場合の前提として認識しておく。
現状 moqt-js は LOC を直接扱っていないが、ドキュメントレベルで言及できる。

## draft-18 参照

- draft-ietf-moq-transport-18 §1.4.2 Location Structure
- draft-ietf-moq-transport-18 §15 IANA Considerations (推定)
- moq-wg/moq-transport#1624

## 影響範囲

- Location 構造体の取り扱い
- 将来的な LOC 拡張対応
- ドキュメント
