# 自発 PUBLISH ストリーム上の REQUEST_UPDATE のデコード失敗が黙殺され subscription の終了通知が失われる

- Created: 2026-08-11
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-stream-request-update-decode-failure
- Polished: {YYYY-MM-DD}
- Updated: 2026-08-15

## 目的

`bidiReadRequestStreamMessages` (`src/session/bidi.ts`) の role=publish パスで、破損した REQUEST_UPDATE (不完全なフィールド構造のペイロード等) を受信すると、デコード失敗 (`IncompleteDataError`) が外側 catch で黙殺され、ストリーム読み取りが停止して subscription の終了通知が失われる問題を修正する。同種の問題は受信 PUBLISH パスで closed issue 0373 が解決済みであり、既存ハンドラにのみ非対称に残っている。

## 現状

- `bidiReadRequestStreamMessages` の REQUEST_UPDATE ケース内で `decodeRequestUpdatePayload` が try/catch なしで呼ばれる。
- 同関数の外側 catch は `toProtocolViolationSessionError` (ProtocolViolationError のみ PROTOCOL_VIOLATION の SessionError に変換) のみを処理し、`IncompleteDataError` は無視する (「それ以外は既存通り無視する」コメント)。
- なお closed issue 0378 実装により、Body 長不一致 (trailing data) は `ProtocolViolationError` として処理され外側 catch で変換されるため、黙殺されるのは不完全なフィールド構造 (データ不足) による `IncompleteDataError` のみである。
- したがって破損 REQUEST_UPDATE を受信すると、ループが終了し、finally で subscribers / requestStreams のエントリが削除される。ピアの後続メッセージ (PUBLISH_DONE / REQUEST_OK / REQUEST_ERROR / FIN) は処理されず、subscription の終了通知 (endCallback / errorCallback) が失われる。セッションは開いたまま。
- closed issue 0373 の新設 free function `bidiHandlePublishRequestUpdate` は、デコード失敗を関数内で catch して PROTOCOL_VIOLATION でセッションを閉じる方式を採用済み (ループ catch が IncompleteDataError を変換しないため)。`bidiReadRequestStreamMessages` 側は未対応のまま。

## 設計方針

- 0373 と同じ理由 (ループ catch は ProtocolViolationError のみ変換する) により、デコード失敗は黙殺せず PROTOCOL_VIOLATION でセッションを閉じる。
- 対応方式は実装時に確定する: (a) REQUEST_UPDATE ケース内で `decodeRequestUpdatePayload` のデコード失敗を catch して `closeWithError(PROTOCOL_VIOLATION)` する (0373 の `bidiHandlePublishRequestUpdate` と同方式)、(b) 外側 catch で `IncompleteDataError` も PROTOCOL_VIOLATION に変換する (他のメッセージのデコード失敗にも波及するため影響範囲の検討が必要)。
- 0373 の `bidiHandlePublishRequestUpdate` (受信 PUBLISH パス) は変更しない。
- REQUEST_UPDATE の Request ID のパリティ・重複検証は本 issue のスコープ外 (closed issue 0381 の注記に委譲済み。0381 実装時に本 issue の Request ID 検証はスコープ外と確定し、残存する)。

## 完了条件

- role=publish パスで破損 REQUEST_UPDATE を受信した場合、黙殺されず PROTOCOL_VIOLATION でセッションが閉じること。
- 上記を検証するテストがあること (テストは `bidiReadRequestStreamMessages` を role=publish で駆動し、実 W3C ストリーム注入方式で破損ペイロードを feed する)。
- 正常な REQUEST_UPDATE の既存処理 (FORWARD 反映 + REQUEST_OK 応答) が変わらないこと (回帰ガード)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

未着手。
