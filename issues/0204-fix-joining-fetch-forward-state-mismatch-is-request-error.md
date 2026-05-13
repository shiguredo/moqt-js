# Joining Fetch の forward state 不整合を request error として扱う

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Joining Fetch リクエストの forward 状態と SUBSCRIBE 側の forward 状態が
矛盾している場合に request error を返すと明示された。
moqt-js は Joining Fetch 発行時の forward state 整合性チェックを実装し、
不整合があればクライアント側でエラーを返す / 受信時はエラー応答として扱う。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.12.2 Joining Fetches
- draft-ietf-moq-transport-18 §10.6 REQUEST_ERROR
- moq-wg/moq-transport#1609

## 影響範囲

- Joining Fetch のバリデーション
- REQUEST_ERROR ハンドリング
