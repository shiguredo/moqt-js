# Request stream 上の GOAWAY による個別リクエストマイグレーションを許可する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で GOAWAY を request stream (SUBSCRIBE / FETCH / PUBLISH などの bidi stream) 上で
送信できるようになり、セッション全体ではなく個別のリクエスト単位でマイグレーションを促せるようになった。
moqt-js は Subscriber / Publisher が GOAWAY を受信したときに該当リクエストのみ移行する処理を実装する。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.4 GOAWAY
- draft-ietf-moq-transport-18 §3.6 Migration
- moq-wg/moq-transport#1617

## 影響範囲

- GOAWAY 受信ハンドラ
- Subscriber / Publisher への通知ルート
- マイグレーション完了までのストリーム維持ロジック
