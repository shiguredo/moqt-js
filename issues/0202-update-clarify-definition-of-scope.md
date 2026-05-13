# scope の定義を明確化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Track の scope (どの namespace ・どの relay 範囲で track が一意となるか) の定義が
明確化された。
moqt-js は scope の解釈に依存するロジック (track 一意性判定など) を仕様に合わせて見直す。

## draft-18 参照

- draft-ietf-moq-transport-18 §2.4.3 Scope
- moq-wg/moq-transport#1629

## 影響範囲

- Track 一意性判定
- 名前衝突検出
- ドキュメント
