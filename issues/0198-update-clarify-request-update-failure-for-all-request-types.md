# 全 request type に対する REQUEST_UPDATE 失敗時の挙動を明確化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で REQUEST_UPDATE が失敗した場合の挙動が全 request type (SUBSCRIBE / FETCH / PUBLISH /
SUBSCRIBE_NAMESPACE 等) について明確化された。
moqt-js は REQUEST_UPDATE 失敗時のリクエスト状態維持 / エラー伝搬を仕様に合わせて見直す。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.9 REQUEST_UPDATE
- draft-ietf-moq-transport-18 §10.9.1 Updating Subscriptions
- draft-ietf-moq-transport-18 §10.9.2 Updating Namespace Subscriptions
- moq-wg/moq-transport#1539

## 影響範囲

- REQUEST_UPDATE 応答 (REQUEST_OK / REQUEST_ERROR) の処理
- 失敗時の state rollback ロジック
