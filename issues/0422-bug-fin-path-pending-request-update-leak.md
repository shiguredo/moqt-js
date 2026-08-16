# ピアの FIN (GOAWAY なし) 時に応答待ちの REQUEST_UPDATE がクリーンアップされない

- Priority: Medium
- Created: 2026-08-16
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-fin-path-pending-request-update-leak
- Polished: {YYYY-MM-DD}

## 目的

ピアが GOAWAY を送らずにストリームを FIN で閉じた場合 (subscribe ロールの失敗経路など)、応答待ちの REQUEST_UPDATE の Promise (`pendingRequestUpdate`) がセッション close まで未解決のまま残る問題を解消する。draft-ietf-moq-transport-19 §10.9.1 に従い、応答を待たずにストリームが閉じた場合は保留中の更新を暗黙の失敗として reject する。

## 現状

- `src/session/bidi.ts` の `bidiReadRequestStreamMessages` の FIN (done) ケースは、`notifySubscriberFin` (error 通知) と自方向 FIN の送信 (writer.close()) を実行するが、`pendingRequestUpdate` を一切触らない。
- `src/session.ts` の `runPublishStreamSubLoop` の FIN (done) ケースも同様に `notifySubscriberFin` のみで、`pendingRequestUpdate` を触らない。
- namespace 系ループは FIN (done) 検出時に `handleNamespaceRequestUpdateStreamClosed` で保留中の更新を掃除済みであり、GOAWAY 受信時の掃除 (`rejectPendingRequestUpdates`、関連 issue で実装) も bidi 系・受信 PUBLISH 系に追加済みだが、GOAWAY なしの FIN 経路のみ未対応。
- 未解決のまま残った `subscriber.update()` の Promise は `session.close()` の一括処理でのみ reject されるため、アプリは GOAWAY / FIN 後に update() の結果を待ち続ける。

## 設計方針

- `bidiReadRequestStreamMessages` の FIN (done) ケースと `runPublishStreamSubLoop` の FIN (done) ケースで、`rejectPendingRequestUpdates` (src/session/bidi.ts の既存ヘルパー) により当該 requestId の保留中 REQUEST_UPDATE を reject してエントリを削除する。namespace ループの `handleNamespaceRequestUpdateStreamClosed` と同じ方式。
- reject するエラーは「stream closed before receiving update response」等の Error (namespace ループと同じ形式)。
- GOAWAY 受信時の掃除 (関連 issue で実装) との二重 reject は、エントリ削除により起きない (reject 済みエントリは削除され、後続の掃除は no-op)。
- 変更対象ファイル: `src/session/bidi.ts` / `src/session.ts` (FIN ケース)、`src/session/bidi.test.ts` / `src/session.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- GOAWAY なしのピア FIN で、該当 requestId の pendingRequestUpdate が reject され、エントリが削除されること。
- `subscriber.update()` の Promise が FIN 後に settle されること (未解決のまま残らないこと)。
- 上記を検証するテストがあること (実 W3C ストリーム注入方式)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.9.1 (REQUEST_UPDATE の失敗時処理)
- 関連: `issues/closed/0406-fix-goaway-pending-request-update-cleanup.md`（GOAWAY 受信時の掃除。本 issue は GOAWAY なしの FIN 経路の別トリガー。共通の `rejectPendingRequestUpdates` を利用する）
- 関連: `issues/closed/0372-moqt-draft-19-duplicate-goaway-on-request-stream-undetected.md`（GOAWAY 送信ガード）

## 解決方法

未着手。
