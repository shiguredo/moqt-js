# SUBGROUP_HEADER type に FIRST_OBJECT ビットを追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で SUBGROUP_HEADER のタイプ値に FIRST_OBJECT ビットが追加された。
最初のオブジェクトであることをタイプ値で示せるようになり、
Subgroup の先頭判定が type を見るだけで可能になる。
タイプ値の割り当てが変わるため、ワイヤーフォーマットの後方互換性がない。

## draft-18 参照

- draft-ietf-moq-transport-18 §11.4.2 Subgroup Header
- moq-wg/moq-transport#1618

## 影響範囲

- SUBGROUP_HEADER タイプ定数
- subgroup ストリーム encoder / decoder
- 既存の SUBGROUP_ID_MODE 関連実装 (0119 で実装済み) との整合性確認
