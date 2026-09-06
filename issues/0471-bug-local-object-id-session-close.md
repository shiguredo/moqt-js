# ローカルの不正 objectId でセッションを閉じてしまう

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-local-object-id-validation
- Polished: YYYY-MM-DD

## 目的

アプリの API 誤用 (範囲外 `objectId`) でセッション全体を破壊するのは誤りであり、`throw` で呼び出し元に返すべきである。現状は送信結果も黙殺される。

## 現状

- `src/session/publish.ts` の `publishSendObjectInternal` は `objectId` の範囲外を `session.closeWithError` (`PROTOCOL_VIOLATION`) して `return` する。
- §11.4.2 の MUST close は受信側の義務であり、送信側の事前検証ではない。

## 設計方針

1. 範囲外 `objectId` は `throw` (英語メッセージ、期待値と実際値を含む) に変更する。
2. 境界値 (0 / 2^64-1 / 超過 / 負) の単体テストを追加する。

## 完了条件

- 不正 `objectId` で `throw` し、セッションが閉じないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.4.2
