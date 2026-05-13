# SUBSCRIBE_NAMESPACE を SUBSCRIBE_NAMESPACE と SUBSCRIBE_TRACKS に分割する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で従来の SUBSCRIBE_NAMESPACE が以下の 2 メッセージに分割された。

- SUBSCRIBE_NAMESPACE: namespace 自体の announcement を購読する
- SUBSCRIBE_TRACKS: namespace 内の track 一覧を購読する

これに伴い、メッセージタイプ・処理ロジック・名前空間応答ストリームの責務が変わる。
ワイヤーフォーマットの後方互換性がない。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.18 SUBSCRIBE_NAMESPACE
- draft-ietf-moq-transport-18 §10.19 SUBSCRIBE_TRACKS
- draft-ietf-moq-transport-18 §6 Namespace Discovery
- draft-ietf-moq-transport-18 §13.7.2 SUBSCRIBE_NAMESPACE and SUBSCRIBE_TRACKS with short prefixes
- moq-wg/moq-transport#1542

## 影響範囲

- `src/session.ts` の SUBSCRIBE_NAMESPACE ハンドリング全体
- メッセージタイプ定数 / encoder / decoder
- devtools の namespace 関連 UI
- 既存の SUBSCRIBE_NAMESPACE 経由の publish discovery フロー
