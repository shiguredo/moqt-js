# ピアの FIN (GOAWAY なし) 時に応答待ちの REQUEST_UPDATE がクリーンアップされない

- Priority: Medium
- Created: 2026-08-16
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-fin-path-pending-request-update-leak
- Polished: 2026-08-20

## 目的

ピアが GOAWAY を送らずにストリームを FIN で閉じた場合 (subscribe ロールの失敗経路など)、応答待ちの REQUEST_UPDATE の Promise (`pendingRequestUpdate`) がセッション close まで未解決のまま残る問題を解消する。応答を待たずにストリームが閉じた場合は保留中の更新を暗黙の失敗として reject する。直接の根拠は draft-ietf-moq-transport-19 §3.3.2 の「An endpoint that receives a FIN before all required messages have arrived treats the request as failed」(bidi 系 FIN への適用。namespace ループの既存実装は §10.9.1 を引用しているが、bidi 系は §3.3.2 がより直接的)。

## 現状

- `src/session/bidi.ts` の `bidiReadRequestStreamMessages` の FIN (done) ケースは、`notifySubscriberFin` (error 通知) と自方向 FIN の送信 (writer.close()) を実行するが、`pendingRequestUpdate` を一切触らない。
- `src/session.ts` の `runPublishStreamSubLoop` の FIN (done) ケースも同様に `notifySubscriberFin` のみで、`pendingRequestUpdate` を触らない。
- namespace 系ループは FIN (done) 検出時に `handleNamespaceRequestUpdateStreamClosed` で保留中の更新を掃除済みであり、GOAWAY 受信時の掃除 (`rejectPendingRequestUpdates`、closed issue 0406 で実装) も bidi 系・受信 PUBLISH 系に追加済みだが、GOAWAY なしの FIN 経路のみ未対応。GOAWAY 受信後の掃除は 0406 で実装済みのため、残る未対応は「GOAWAY なしのピア FIN」のみである。
- 未解決のまま残った `subscriber.update()` の Promise は `session.close()` の一括処理でのみ reject されるため、アプリは FIN 後に update() の結果を待ち続ける。
- スコープ: FETCH は REQUEST_UPDATE 送信経路を持たない (Fetcher インターフェースに update がない) ため対象外。RESET_STREAM 経路 (外側 catch で pending を触らない) は open issue 0410 の対象 (0410 が「RESET 経路は本 issue の残余リスクとして記録」と明記)。bidi 系 unsubscribe 経路 (`bidiCancelSubscription`) は `readable.cancel()` で受信方向を閉じるため FIN (done) ケースに到達せず、本 issue では解消されない (0414 の「bidi 系は未起票の別 issue で対応」と整合)。

## 設計方針

- `bidiReadRequestStreamMessages` の FIN (done) ケースと `runPublishStreamSubLoop` の FIN (done) ケースで、`rejectPendingRequestUpdates` (src/session/bidi.ts の既存ヘルパー) により当該 requestId の保留中 REQUEST_UPDATE を reject してエントリを削除する。namespace ループの `handleNamespaceRequestUpdateStreamClosed` と同じ方式。
- reject するエラーは「stream closed before receiving update response」等の Error (namespace ループと同じ形式)。
- **対象ロール**: `bidiReadRequestStreamMessages` は publish / subscribe 両ロール共通だが、publish ロールには REQUEST_UPDATE 送信経路が存在しない (Publisher インターフェースに update がない) ため pending は発生せず no-op。実質対象は subscribe ロール (bidi 系) と受信 PUBLISH の subscriber (runPublishStreamSubLoop) のみ。reject の追加は subscribe ロールの処理内 (FIN (done) ケースの `notifySubscriberFin` 呼び出しの後、writer.close() と並ぶ位置) に置く。
- **reject エラー形式の混在**: 同じ `update()` の Promise の reject 形式はトリガーによって異なる (GOAWAY 掃除は `RequestError(GOING_AWAY)`、REQUEST_ERROR ケースは `RequestError`、本 issue の FIN は `Error`)。これはトリガーごとに失敗の種類が異なるため許容する。設計方針でこの意図を明記する。
- **GOAWAY 後 FIN との整合**: 0406 実装後の GOAWAY 受信済みストリームは `closeOldRequestStreamOnGoaway` が `rejectPendingRequestUpdates` 済みで、後続のピア FIN 時の reject はエントリ削除済みのため no-op になる。`notifySubscriberFin` も `goawayReceivedOnRequestStreams` ガードで no-op。本 issue の修正はこの整合を壊さない。
- **配置順序**: `bidiReadRequestStreamMessages` の FIN (done) ケースは `try { notifySubscriberFin() } finally { writer.close() }` 構造であり、reject はこの try/finally 内 (notifySubscriberFin 後) に置く。`runPublishStreamSubLoop` も同様に `notifySubscriberFin` の後に置く。`rejectPendingRequestUpdates` は同期で throw しないため、どの位置でも最終実行されるが、分岐直後に置いて一貫性を保つ。
- GOAWAY 受信時の掃除 (関連 issue で実装) との二重 reject は、エントリ削除により起きない (reject 済みエントリは削除され、後続の掃除は no-op)。
- 変更対象ファイル: `src/session/bidi.ts` / `src/session.ts` (FIN ケース)、`src/session/bidi.test.ts` / `src/session.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- GOAWAY なしのピア FIN で、該当 requestId の pendingRequestUpdate が reject され、エントリが削除されること (GOAWAY 受信後の FIN ではエントリ削除済みのため no-op となることも含む)。
- `subscriber.update()` の Promise が FIN 後に settle されること (未解決のまま残らないこと)。
- 上記を検証するテストがあること (実 W3C ストリーム注入方式)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.2 (Graceful Request Stream Closure / 「An endpoint that receives a FIN before all required messages have arrived treats the request as failed」)
- draft-ietf-moq-transport-19 §10.9 / §10.9.1 (REQUEST_UPDATE の失敗時処理)
- 関連: `issues/closed/0406-fix-goaway-pending-request-update-cleanup.md`（GOAWAY 受信時の掃除。本 issue は GOAWAY なしの FIN 経路の別トリガー。共通の `rejectPendingRequestUpdates` を利用する）
- 関連: `issues/closed/0372-moqt-draft-19-duplicate-goaway-on-request-stream-undetected.md`（GOAWAY 送信ガード）
- 関連: `issues/closed/0374-moqt-draft-19-fin-without-publish-done-not-notified.md`（残余リスク (5) として FIN 経路の pending 未解決を記録。本 issue はその解消）
- 関連: `issues/0410-bug-subscribe-error-end-not-notified.md`（RESET_STREAM 経路のエラー終了通知。RESET 経路の pending リークは 0410 の残余リスクとして記録）

## 解決方法

未着手。
