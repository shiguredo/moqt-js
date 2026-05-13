# Relay が LARGEST_OBJECT について嘘をつくことを禁止する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で relay が LARGEST_OBJECT パラメータについて
保有していないオブジェクトを保有していると主張することが禁止された。
moqt-js は relay 役ではないが、Subscriber 側で LARGEST_OBJECT 値を信頼して動作するロジック
(Joining Fetch のレンジ計算など) を仕様前提に合わせて確認する。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.2.11 LARGEST OBJECT Parameter
- draft-ietf-moq-transport-18 §9.1 Caching Relays
- moq-wg/moq-transport#1621

## 影響範囲

- LARGEST_OBJECT の使われ方を確認
- Joining Fetch レンジ計算 (§10.12.2.1) の前提
- ドキュメント
