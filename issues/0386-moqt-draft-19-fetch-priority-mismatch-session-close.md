# FETCH 応答の同一 Subgroup Priority 不一致を PROTOCOL_VIOLATION で処理する

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-fetch-priority-mismatch-session-close
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §2.4.2 (Malformed Tracks) の扱いに従い、FETCH 応答で同一 Subgroup 内の Publisher Priority 不一致を検出した場合に、セッションを閉じず対象の FETCH をキャンセルする。現在は ProtocolViolationError (セッション終了) を送出する。

## 優先度根拠

§2.4.2 は「An Object with a particular Subgroup ID is received, but its Publisher Priority is different from that of the previous Object with the same Subgroup ID」を malformed track と定義し、正しい対処は「cancel any corresponding subscription or fetches for that Track from that publisher」でありセッション終了ではない。Low。

## 現状

- `src/dataStream.ts:1440-1449` (`decodeFetchObjectFields`) は同一 Subgroup の Priority 不一致を検出し、コメントでは「MALFORMED_TRACK エラー」と書いているが、実際には `ProtocolViolationError` を throw する。
- セッション終了ではなく、対応する FETCH のキャンセルが §2.4.2 の正しい扱い。

## 設計方針

- Priority 不一致の検出は維持しつつ、throw するエラーをセッション終了を引き起こさない形 (対象 FETCH のキャンセル経路) に変更する。
- 受信側 (`src/session/incoming.ts` / fetcher 経路) で当該 FETCH のデータストリームをリセットし、fetcher の error コールバックで通知する。
- 既存の `MalformedTrackError` の利用を検討する (現在は未使用)。

## 完了条件

- FETCH 応答で同一 Subgroup の Priority 不一致を検出してもセッションが閉じず、対象 FETCH がキャンセルされ error コールバックが呼ばれること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §2.4.2 (Malformed Tracks)
- draft-ietf-moq-transport-19 §11.4.4 (Fetch Header / Fetch Object Fields)

## 解決方法

未着手。
