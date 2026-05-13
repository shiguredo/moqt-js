# Joining Fetch と forward state 遷移の順序を明確化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Joining Fetch と SUBSCRIBE の forward state 遷移との
処理順序 (forward 0→1 遷移時の Joining Fetch 開始タイミング、
forward 1→0 時の取り扱いなど) が明確化された。
moqt-js は Joining Fetch の発行タイミングと SUBSCRIBE 状態の関係を仕様に合わせる。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.12.2 Joining Fetches
- draft-ietf-moq-transport-18 §10.9.1 Updating Subscriptions
- draft-ietf-moq-transport-18 §5.1.3 Joining an Ongoing Track
- moq-wg/moq-transport#1577

## 影響範囲

- Joining Fetch の発行タイミング
- forward state 遷移時の処理順序
