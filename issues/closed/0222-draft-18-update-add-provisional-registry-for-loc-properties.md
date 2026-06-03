# LOC Properties 用の provisional registry を追加する

- Priority: Medium

Created: 2026-05-13
Model: Opus 4.7

- Branch: feature/draft-18
- Polished: 2026-06-02

## 概要

draft-18 で LOC (Location 構造体) Properties 用の provisional IANA registry が追加された。
moqt-js は LOC Properties を直接扱うコード (`src/loc.ts`) を持っており、
将来的な LOC 拡張の登録枠組みとして認識しておく。
現状の LOC 実装への影響はない。コメント更新のみ。

## RFC 参照

draft-ietf-moq-transport-18 A.1: "Add provisional registry for LOC properties (#1624)"

## 変更内容

1. `src/loc.ts` の JSDoc に IANA registry への参照を追記する

## 該当ファイル

| ファイル     | 行番号 | 変更内容                                              |
| ------------ | ------ | ----------------------------------------------------- |
| `src/loc.ts` | (全般) | JSDoc に IANA provisional registry への参照を追記する |

## 期待される動作

- LOC Properties のエンコード/デコードに変更はない
- 将来 LOC Properties の登録が進んだ場合、`MOQTLOCPropertyId` の列挙に追加する

## テスト方針

- 既存テストの変更は不要

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり

## 解決方法

moqt-js はクライアント専用実装であり、本 issue の仕様変更はクライアント側のコード変更を伴わない。仕様理解のための確認をもって完了とする。
