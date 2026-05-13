# 未知エラーコード受信時にセッションを閉じない

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で未知のエラーコードを受信した際にセッションを閉じてはならないと明示された。
未知エラーは握りつぶしまたは特定 stream 単位の reset として扱う。
moqt-js は現在のエラーコードバリデーション (未知 → PROTOCOL_VIOLATION でセッション切断) を
見直し、未知エラーコードはセッションを維持する挙動に変える必要がある。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.6 REQUEST_ERROR
- draft-ietf-moq-transport-18 §15 IANA Considerations (エラーコード登録)
- moq-wg/moq-transport#1561

## 影響範囲

- `src/error.ts` の未知エラー処理
- 制御メッセージ受信時のセッション維持判定
- 既存の PROTOCOL_VIOLATION テストの見直し
