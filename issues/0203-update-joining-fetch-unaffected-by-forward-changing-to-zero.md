# Joining Fetch を forward が 0 に変わっても影響させない

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Joining Fetch は SUBSCRIBE 側の forward フラグが 0 (停止) に変化しても
影響を受けないと明示された。
過去レンジの取得は独立した処理として完遂する必要がある。
moqt-js の Joining Fetch 実装が forward 0 遷移時に Joining Fetch を打ち切っていないか確認する。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.12.2 Joining Fetches
- draft-ietf-moq-transport-18 §10.9.1 Updating Subscriptions
- moq-wg/moq-transport#1620

## 影響範囲

- Joining Fetch のキャンセル条件
- forward フラグ変化時の処理 (REQUEST_UPDATE 関連)
