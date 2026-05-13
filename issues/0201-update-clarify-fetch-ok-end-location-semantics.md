# FETCH_OK の End Location semantics を明確化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で FETCH_OK の End Location フィールドの意味 (exclusive / inclusive、
未確定時の扱いなど) が明確化された。
moqt-js は FETCH_OK の End Location 解釈とフェッチ完了判定を仕様に合わせる。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.13 FETCH_OK
- draft-ietf-moq-transport-18 §10.12 FETCH
- moq-wg/moq-transport#1536

## 影響範囲

- FETCH_OK パース / End Location 比較ロジック
- Joining Fetch の完了判定
