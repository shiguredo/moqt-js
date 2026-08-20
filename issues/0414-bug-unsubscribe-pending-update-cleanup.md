# unsubscribe() が in-flight の REQUEST_UPDATE (pendingRequestUpdate / pendingPrefix) を掃除しない

- Priority: Medium
- Created: 2026-08-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-unsubscribe-pending-update-cleanup
- Polished: 2026-08-20

## 目的

`NamespaceSubscription.unsubscribe()` / `TracksSubscription.unsubscribe()` を in-flight (REQUEST_OK 未受信) の更新がある状態で呼んだ場合、応答待ちの `pendingRequestUpdate` エントリと `pendingPrefix` が掃除されず、`update()` の Promise が永不解決になり得る問題を解消する。対象は namespace / tracks 系 (`closeNamespaceSubscription` / `closeTracksSubscription`) のみであり、bidi 系 SUBSCRIBE の `Subscriber.unsubscribe()` (`bidiCancelSubscription`) の同種リークは本 issue のスコープ外 (別途対応が必要な旨は後述)。

## 現状

- `closeNamespaceSubscription` / `closeTracksSubscription` (`src/session.ts`) は `state = "closed"` → `writer.close()` (FIN 送信) → Map 削除のみを行い、`pendingRequestUpdate` (当該 requestId を `targetRequestId` とするエントリ) と `subscription.pendingPrefix` を掃除しない。
- ピアが FIN / REQUEST_ERROR を返せば受信ループの経路で `pendingRequestUpdate` は reject される (FIN は done 経路の `handleNamespaceRequestUpdateStreamClosed`、REQUEST_ERROR は REQUEST_ERROR ケースの `handleNamespaceRequestUpdateError`)。REQUEST_OK は reject ではなく resolve される (`resolvePendingRequestUpdate`)。しかしピアが無応答のままストリームを開いておく場合、`update()` の Promise は永不解決のまま残り、`pendingRequestUpdate` エントリもセッション close まで残留する。
- 残留エントリは `bidiSendNamespaceRequestUpdate` の MAX_REQUEST_UPDATES 判定 (`bidi.ts` の `pendingRequestUpdate` 走査) にカウントされ続ける。ただし unsubscribe 後は `sendNamespaceRequestUpdate` が "not active" で throw するため、実際の送信阻害は限定的。主たる害は update() の Promise 未解決のみである (残留 pendingPrefix は unsubscribe 後の update() が "not active" で throw するため in-flight 判定に到達せず、実質害を及ぼさない)。
- bidi 系 SUBSCRIBE の `Subscriber.unsubscribe()` (`bidiCancelSubscription`、`src/session/bidi.ts`) も `pendingRequestUpdate` を掃除しないため同種のリークを持つが、トリガー経路が異なり (bidi 系は 0406 が GOAWAY トリガーを扱う)、本 issue では対象外とする。なお bidi 系 unsubscribe 経路の掃除を扱う open issue は現時点で存在せず、別 issue での対応が必要 (未起票)。
- 関連: `issues/closed/0406-fix-goaway-pending-request-update-cleanup.md` (GOAWAY 受信時の掃除。本 issue は unsubscribe 時の掃除の別トリガー)。

## 設計方針

- `closeNamespaceSubscription` / `closeTracksSubscription` で、当該 requestId を `targetRequestId` とする `pendingRequestUpdate` のエントリを reject して削除し、`subscription.pendingPrefix` をクリアする。利用可能な既存ヘルパーは `bidi.rejectPendingRequestUpdates` (export 済み。pendingPrefix はクリアしないため、クリアは session.ts 側で明示的に行う)。`rejectPendingNamespaceUpdates` (namespaceLoops.ts) は module-private のため session.ts からは利用できない。
- reject のエラーはストリームクローズ由来である旨が分かる文言にする (既存の `handleNamespaceRequestUpdateStreamClosed` と同じ "stream closed before receiving update response" に揃える)。
- **受信ループの生存と遅延応答の扱い**: `closeNamespaceSubscription` / `closeTracksSubscription` は reader を閉じないため、unsubscribe 後も受信ループは `streamReader.read()` にブロックしたまま生存する。正常なピアは §10.9 の MUST「The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK or REQUEST_ERROR message ... indicating if the update was successful, unless it is coalescing failed updates to produce just one REQUEST_ERROR for multiple REQUEST_UPDATE messages」に従い応答を返すため、unsubscribe 後に遅延 REQUEST_OK / REQUEST_ERROR が届き得る。pending エントリを掃除しただけでは `handleNamespaceRequestUpdateOk` の「received second REQUEST_OK」ガード (`hasPendingRequestUpdate` が false) や REQUEST_ERROR 側の「received REQUEST_ERROR after REQUEST_OK」ガードが発火してセッション全体が PROTOCOL_VIOLATION で閉じる回帰が入る。
- **推奨方式 (a)（state ガード）を主案とする**: 受信ループのメッセージ処理（for ループ）冒頭で `subscription.state !== "active"` のガードを追加し、unsubscribe 後の遅延応答 (REQUEST_OK / REQUEST_ERROR / NAMESPACE / NAMESPACE_DONE / PUBLISH_SKIPPED / GOAWAY) を処理しない。方式 (b)（`streamReader.cancel()`）単独では、read() が既に解決済みのデータを保持している場合に cancel() が効かず、そのデータが state="closed" のまま処理される競合窓が残るため、方式 (a) の state ガードの併用が実質必須である（メッセージ処理ループは `while (subscription.state === "active")` のループ冒頭でのみ state を検査し、for ループ内の各メッセージ処理では検査しないため）。
- 方式 (a) のガードで「無視して継続」すると、unsubscribe 後にデータが到着した場合は、最初の read() バッチを処理した直後のイテレーションで while 条件によりループは終了する（データが到着しない限りピアの FIN まで生存し続けるわけではない）。ただし、その 1 バッチ内の NAMESPACE / NAMESPACE_DONE / GOAWAY はガードがなければ処理され得る（`namespaceHandleGoaway` は state ガードを持たず、unsubscribe 済みのサブスクリプションに callbacks.goaway が発火し得る）ため、for ループ冒頭の state ガードで抑止する (callbacks.onNamespace / callbacks.goaway の spurious 発火抑止も完了条件で検証する)。
- 方式 (b)（`streamReader.cancel()`）は、受信ループの read() ブロックを解消してループを終了させる効果を持つ（方式 (a) 単独ではピア無応答時に read() ブロックが残る資源面の差がある）。なお方式 (b) の `streamReader.cancel()` は §6.1 / §3.3.3 の STOP_SENDING 相当であり、現行の FIN 送信によるキャンセルより仕様整合性の観点で優位である。実装時は方式 (a) を主案としつつ、必要に応じて方式 (b) を併用して read() ブロックを解消する。
- **無観測 reject の抑制**: `bidiSendNamespaceRequestUpdate` の update() の返り値 Promise をアプリが観測しない fire-and-forget 利用時に、本 issue の掃除 (`rejectPendingRequestUpdates`) が新たな reject トリガーとなるため、0406 が `bidiSendRequestUpdate` に追加した無観測 reject 抑制 (`promise.catch(() => {})`、bidi.ts) と同様の抑制を `bidiSendNamespaceRequestUpdate` にも実装する。
- 変更対象ファイル: `src/session.ts` (`closeNamespaceSubscription` / `closeTracksSubscription`)、`src/session/namespaceLoops.ts` (方式 (a) の遅延応答ガード。`namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` の 2 ループが対象。`namespaceStartPublicationStreamLoop` は update() を持たないため対象外)、該当テスト (テスト追加。`closeNamespaceSubscription` は private メソッドのため、0406 / 0372 の実 W3C ストリーム注入方式を流用した session 統合テストまたはテスト基盤の拡張が必要)、`CHANGES.md`。同一ファイル・同一テストファイルを変更対象とする open issue 0407 / 0408 (GOAWAY ケース) と 0415 (デコード失敗処理) と実装順序に注意する。

## 完了条件

- in-flight の更新がある状態で `unsubscribe()` を呼ぶと、`update()` の Promise が reject されること。
- `pendingRequestUpdate` に当該 requestId のエントリが残らないこと。
- `pendingPrefix` がクリアされること。
- unsubscribe 後に遅延した REQUEST_OK / REQUEST_ERROR が届いてもセッションが PROTOCOL_VIOLATION で閉じないこと (方式 (a) による回帰ガード。方式 (b) は read() ブロック解消の補助)。
- unsubscribe 後に遅延した NAMESPACE / NAMESPACE_DONE / GOAWAY による callbacks.onNamespace / callbacks.goaway の spurious 発火が抑止されること (方式 (a) のガード)。
- アプリが `update()` の返り値 Promise を観測しない fire-and-forget 利用時に unhandled rejection が発生しないこと (無観測 reject の抑制)。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE / 「The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK or REQUEST_ERROR message, unless it is coalescing failed updates to produce just one REQUEST_ERROR for multiple REQUEST_UPDATE messages」)
- draft-ietf-moq-transport-19 §10.3.1.7 (MAX_REQUEST_UPDATES / 「A REQUEST_UPDATE is considered outstanding from when it is sent until the sender receives the corresponding REQUEST_OK or REQUEST_ERROR response」)
- draft-ietf-moq-transport-19 §6.1 (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS のキャンセル) / §3.3.3 (Request Cancellation and Rejection / RESET_STREAM・STOP_SENDING によるキャンセル)
- 関連: `issues/closed/0406-fix-goaway-pending-request-update-cleanup.md`（GOAWAY 受信時の掃除。本 issue は unsubscribe 時の掃除の別トリガー。共通の `rejectPendingRequestUpdates` を利用する）

## 解決方法

未着手。
