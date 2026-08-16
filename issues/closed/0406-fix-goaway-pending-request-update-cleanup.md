# GOAWAY 受信時に応答待ちの REQUEST_UPDATE がクリーンアップされない

- Priority: Medium
- Created: 2026-08-10
- Completed: 2026-08-16
- Branch: feature/fix-goaway-pending-request-update-cleanup
- Polished: 2026-08-16

## 目的

GOAWAY 受信前に送信済みで応答待ちの REQUEST_UPDATE の Promise (`pendingRequestUpdate`) が、ピアがストリームを FIN で閉じた場合に未解決のまま残る問題を解消する。draft-ietf-moq-transport-19 §10.4 の「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue that specific request ... and close the old request stream」に従い、旧ストリーム上の未応答 REQUEST_UPDATE は GOAWAY 受信時点で失敗として扱う。

## 現状

- GOAWAY ハンドラ (`bidiReadRequestStreamMessages` の GOAWAY ケース / `runPublishStreamSubLoop` の GOAWAY ケース) は `pendingRequestUpdate` を一切触らない。
- GOAWAY 前に送信した REQUEST_UPDATE の応答 (REQUEST_OK / REQUEST_ERROR) は、GOAWAY 後の読み取り継続中に受信すれば既存の REQUEST_OK / REQUEST_ERROR ケースで解決される。しかしピアが応答を送らずに FIN でストリームを閉じた場合、`pendingRequestUpdate` のエントリはセッション close まで残り、`subscriber.update()` の Promise が未解決のままになる (reject されるのは `session.close()` の一括処理のみ)。
- 0372 の `bidiSendRequestUpdate` に追加した GOAWAY 送信ガードは「新規送信」のみを防ぎ、既存の pending エントリは対象外 (0372 のエッジケース (d) として明示的にスコープ外にされた残余)。
- 対象は bidi 系ストリーム (SUBSCRIBE / PUBLISH のリクエストストリーム) のみ。FETCH は REQUEST_UPDATE 送信経路を持たず (Fetcher インターフェースに update がない) established 後に読み取りループも存在しないため、pendingRequestUpdate エントリは発生しない。namespace 系 3 ループはピア FIN 経路の `handleNamespaceRequestUpdateStreamClosed` と GOAWAY 後 REQUEST_ERROR 経路の `rejectPendingNamespaceUpdates` で既に掃除済みのため対象外。制御ストリーム上の GOAWAY (`handleGoaway`) も本 issue のスコープ外。

## 設計方針

- GOAWAY 受信時に、当該 requestId を targetRequestId とする `pendingRequestUpdate` のエントリを `rejectPendingRequestUpdates` (src/session/bidi.ts の既存ヘルパー) で reject して削除する。reject するエラーは `RequestError` (`RequestErrorCode.GOING_AWAY` + 既存の `REQUEST_GOING_AWAY_REASON` "request stream is being migrated") とする (既存 REQUEST_ERROR ケースと同じ形式)。
- 読み取り継続中に後続の REQUEST_OK / REQUEST_ERROR が届いた場合に二重解決しないよう、reject 済みエントリは削除する (既存の REQUEST_ERROR ケースの coalescing 処理と同様。エントリ削除後は `resolvePendingRequestUpdate` が undefined を返し no-op になる)。この結果、GOAWAY 後に届く REQUEST_OK による Forward State / Range Filters の反映は行われなくなる (挙動変化。GOAWAY 受信時点で旧ストリームの更新は失敗扱いになるため)。なお `bidiHandleRequestUpdateOk` の LARGEST_OBJECT 処理は pending エントリの有無に関わらず実行されるため、GOAWAY 後の遅延 REQUEST_OK による `setLargestLocation` 反映は残る (許容する)。
- GOAWAY ガードとエントリ登録・write の間は同期実行のため、ガード通過後に GOAWAY が処理される時点ではエントリは必ず登録済みであり、本 issue の修正で掃除対象になる。実際に残留し得るのは GOAWAY 受信前に write が失敗した場合 (ピアの RESET 等) のみであり、これは本 issue の対象外とする (write 失敗時の掃除は別途検討)。
- 変更対象ファイル: `src/session/bidi.ts` (`bidiReadRequestStreamMessages` の GOAWAY ケース / `runPublishStreamSubLoop` の GOAWAY ケースは src/session.ts 側)、`src/session/bidi.test.ts` / `src/session.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- GOAWAY 受信時に、該当 requestId の pendingRequestUpdate が reject され、エントリが削除されること。
- `subscriber.update()` の Promise が GOAWAY 後に settle されること (未解決のまま残らないこと。resolve ではなく reject)。
- GOAWAY 受信後に後続の REQUEST_OK / REQUEST_ERROR が届いても二重解決・Forward State 誤反映が起きないこと。
- 上記を検証するテストがあること (0372 で追加済みの実 W3C ストリーム注入方式の GOAWAY 統合テストと同方式)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.4 (GOAWAY)（「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue that specific request ... and close the old request stream using the appropriate mechanism」）
- draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE)
- 関連: `issues/closed/0372-moqt-draft-19-duplicate-goaway-on-request-stream-undetected.md`（GOAWAY 送信ガードの追加。既存 pending の掃除はエッジケース (d) としてスコープ外にされた）
- 関連: `issues/0414-bug-unsubscribe-pending-update-cleanup.md`（unsubscribe 時の掃除。本 issue は GOAWAY 受信時の別トリガー。共通の `rejectPendingRequestUpdates` を利用する）

## 解決方法

- `src/session/bidi.ts` の `bidiReadRequestStreamMessages` の GOAWAY ケースに、`rejectPendingRequestUpdates` (RequestError + GOING_AWAY + REQUEST_GOING_AWAY_REASON) を追加し、GOAWAY 受信時点で旧ストリーム上の未応答 REQUEST_UPDATE を失敗として扱った。GOAWAY 後の読み取り継続中に REQUEST_OK / REQUEST_ERROR が届いても、エントリ削除済みのため二重解決しない。
- `src/session.ts` の `runPublishStreamSubLoop` (受信 PUBLISH 経路) の GOAWAY ケースにも同様の掃除を追加した。既存の REQUEST_ERROR ケースのインライン実装も `bidi.rejectPendingRequestUpdates` に置き換えて重複を排除した。
- GOAWAY ケースの旧ストリーム終了処理 (goawayCallback 呼び出し + pending 掃除 + writer.close()) を `closeOldRequestStreamOnGoaway` ヘルパーに抽出した。アプリの goawayCallback が throw しても掃除と close() が実行されるよう try/catch で黙殺する。
- `bidiSendRequestUpdate` に write 失敗時のエントリ削除と、登録 Promise の無観測 reject 抑制 (`promise.catch`) を追加し、GOAWAY 掃除やセッション close との競合で unhandled rejection を生まないようにした。controlWriter チェックもエントリ登録前に移動した。
- `REQUEST_GOING_AWAY_REASON` を export に変更した。
- テスト: `src/session/bidi.test.ts` に subscribe ロールの GOAWAY で reject + 二重解決しない (Forward State 誤反映なし) / goawayCallback throw 時の掃除継続 / write 失敗時のエントリ削除を追加。`src/session.test.ts` に受信 PUBLISH ストリームの GOAWAY で reject を追加。
