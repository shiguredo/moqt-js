# unsubscribe() が in-flight の REQUEST_UPDATE (pendingRequestUpdate / pendingPrefix) を掃除しない

- Priority: Medium
- Created: 2026-08-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-unsubscribe-pending-update-cleanup
- Polished: 2026-08-16

## 目的

`NamespaceSubscription.unsubscribe()` / `TracksSubscription.unsubscribe()` を in-flight (REQUEST_OK 未受信) の更新がある状態で呼んだ場合、応答待ちの `pendingRequestUpdate` エントリと `pendingPrefix` が掃除されず、`update()` の Promise が永不解決になり得る問題を解消する。対象は namespace / tracks 系 (`closeNamespaceSubscription` / `closeTracksSubscription`) のみであり、bidi 系 SUBSCRIBE の `Subscriber.unsubscribe()` (`bidiCancelSubscription`) の同種リークは本 issue のスコープ外 (別途対応が必要な旨は後述)。

## 現状

- `closeNamespaceSubscription` / `closeTracksSubscription` (`src/session.ts`) は `state = "closed"` → `writer.close()` (FIN 送信) → Map 削除のみを行い、`pendingRequestUpdate` (当該 requestId を `targetRequestId` とするエントリ) と `subscription.pendingPrefix` を掃除しない。
- ピアが FIN / REQUEST_ERROR を返せば受信ループの経路で `pendingRequestUpdate` は reject される (FIN は done 経路の `handleNamespaceRequestUpdateStreamClosed`、REQUEST_ERROR は REQUEST_ERROR ケースの `handleNamespaceRequestUpdateError`)。REQUEST_OK は reject ではなく resolve される (`resolvePendingRequestUpdate`)。しかしピアが無応答のままストリームを開いておく場合、`update()` の Promise は永不解決のまま残り、`pendingRequestUpdate` エントリもセッション close まで残留する。
- 残留エントリは `bidiSendNamespaceRequestUpdate` の MAX_REQUEST_UPDATES 判定 (`bidi.ts` の `pendingRequestUpdate` 走査) にカウントされ続ける。ただし unsubscribe 後は `sendNamespaceRequestUpdate` が "not active" で throw するため、実際の送信阻害は限定的。主たる害は update() の Promise 未解決のみである (残留 pendingPrefix は unsubscribe 後の update() が "not active" で throw するため in-flight 判定に到達せず、実質害を及ぼさない)。
- bidi 系 SUBSCRIBE の `Subscriber.unsubscribe()` (`bidiCancelSubscription`、`src/session/bidi.ts`) も `pendingRequestUpdate` を掃除しないため同種のリークを持つが、トリガー経路が異なり (bidi 系は 0406 が GOAWAY トリガーを扱う)、本 issue では対象外とする (別 issue での対応が必要)。
- 関連: `issues/0406-fix-goaway-pending-request-update-cleanup.md` (GOAWAY 受信時の掃除。本 issue は unsubscribe 時の掃除の別トリガー)。

## 設計方針

- `closeNamespaceSubscription` / `closeTracksSubscription` で、当該 requestId を `targetRequestId` とする `pendingRequestUpdate` のエントリを reject して削除し、`subscription.pendingPrefix` をクリアする。利用可能な既存ヘルパーは `bidi.rejectPendingRequestUpdates` (export 済み。pendingPrefix はクリアしないため、クリアは session.ts 側で明示的に行う)。`rejectPendingNamespaceUpdates` (namespaceLoops.ts) は module-private のため session.ts からは利用できない。
- reject のエラーはストリームクローズ由来である旨が分かる文言にする (既存の `handleNamespaceRequestUpdateStreamClosed` と同じ "stream closed before receiving update response" に揃える)。
- **受信ループの生存と遅延応答の扱い**: `closeNamespaceSubscription` / `closeTracksSubscription` は reader を閉じないため、unsubscribe 後も受信ループは `streamReader.read()` にブロックしたまま生存する。正常なピアは §10.9 の MUST「The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK or REQUEST_ERROR message」に従い応答を返すため、unsubscribe 後に遅延 REQUEST_OK / REQUEST_ERROR が届き得る。pending エントリを掃除しただけでは `handleNamespaceRequestUpdateOk` の「received second REQUEST_OK」ガード (`hasPendingRequestUpdate` が false) が発火してセッション全体が PROTOCOL_VIOLATION で閉じる回帰が入る。したがって、次のいずれか (または両方) を実装する:
  - (a) 受信ループの REQUEST_OK / REQUEST_ERROR 処理に `subscription.state !== "active"` のガードを追加し、unsubscribe 後の遅延応答を処理しない
  - (b) `closeNamespaceSubscription` / `closeTracksSubscription` で reader 側も閉じ (例: `streamReader.cancel()`)、ループの catch 経路 (既存の `handleNamespaceRequestUpdateStreamClosed` 呼び出し) に後始末を委ねる
- 方式 (a) を選ぶ場合、ガードで「無視して継続」すると unsubscribe 後もループはピアの FIN まで生存し、NAMESPACE / NAMESPACE_DONE / GOAWAY が処理され続ける (`namespaceHandleGoaway` は state ガードを持たず、unsubscribe 済みのサブスクリプションに callbacks.goaway が発火し得る)。「ガードでループを終了する」か、方式 (b) を選ぶことでこの副作用を回避できる。
- 変更対象ファイル: `src/session.ts` (`closeNamespaceSubscription` / `closeTracksSubscription`)、`src/session/namespaceLoops.ts` (方式 (a) の場合の遅延応答ガード)、該当テスト (テスト追加。`closeNamespaceSubscription` は private メソッドのため、session 統合テストまたはテスト基盤の拡張が必要)、`CHANGES.md`。

## 完了条件

- in-flight の更新がある状態で `unsubscribe()` を呼ぶと、`update()` の Promise が reject されること。
- `pendingRequestUpdate` に当該 requestId のエントリが残らないこと。
- `pendingPrefix` がクリアされること。
- unsubscribe 後に遅延した REQUEST_OK / REQUEST_ERROR が届いてもセッションが PROTOCOL_VIOLATION で閉じないこと (方式 (a) / (b) による回帰ガード)。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE / 「The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK or REQUEST_ERROR message」)
- draft-ietf-moq-transport-19 §10.3.1.7 (MAX_REQUEST_UPDATES / 「A REQUEST_UPDATE is considered outstanding from when it is sent until the sender receives the corresponding REQUEST_OK or REQUEST_ERROR response」)
- draft-ietf-moq-transport-19 §6.1 (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS のキャンセル)
- 関連: `issues/0406-fix-goaway-pending-request-update-cleanup.md`（GOAWAY 受信時の掃除。本 issue は unsubscribe 時の掃除の別トリガー。共通の `rejectPendingRequestUpdates` を利用する）

## 解決方法

未着手。
