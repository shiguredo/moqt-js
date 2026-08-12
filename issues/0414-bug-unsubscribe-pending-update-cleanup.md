# unsubscribe() が in-flight の REQUEST_UPDATE (pendingRequestUpdate / pendingPrefix) を掃除しない

- Priority: Medium
- Created: 2026-08-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-unsubscribe-pending-update-cleanup
- Polished: {YYYY-MM-DD}

## 目的

`NamespaceSubscription.unsubscribe()` / `TracksSubscription.unsubscribe()` を in-flight (REQUEST_OK 未受信) の更新がある状態で呼んだ場合、応答待ちの `pendingRequestUpdate` エントリと `pendingPrefix` が掃除されず、`update()` の Promise が永不解決になり得る問題を解消する。

## 現状

- `closeNamespaceSubscription` / `closeTracksSubscription` (`src/session.ts`) は `state = "closed"` → `writer.close()` (FIN 送信) → Map 削除のみを行い、`pendingRequestUpdate` (当該 requestId を `targetRequestId` とするエントリ) と `subscription.pendingPrefix` を掃除しない。
- ピアが FIN / REQUEST_OK / REQUEST_ERROR を返せば受信ループの done 経路で `pendingRequestUpdate` は reject されるが、ピアが無応答のままストリームを開いておく場合、`update()` の Promise は永不解決のまま残り、`pendingRequestUpdate` エントリもセッション close まで残留する (次回の `bidiSendNamespaceRequestUpdate` の MAX_REQUEST_UPDATES 判定にカウントされ続ける)。
- 関連: `issues/0406-fix-goaway-pending-request-update-cleanup.md` (GOAWAY 受信時の掃除。本 issue は unsubscribe 時の掃除の別トリガー)。

## 設計方針

- `closeNamespaceSubscription` / `closeTracksSubscription` で、当該 requestId を `targetRequestId` とする `pendingRequestUpdate` のエントリを reject して削除し、`subscription.pendingPrefix` をクリアする (受信ループの `handleNamespaceRequestUpdateStreamClosed` 相当の後始末)。
- reject のエラーはストリームクローズ由来である旨が分かる文言にする。

## 完了条件

- in-flight の更新がある状態で `unsubscribe()` を呼ぶと、`update()` の Promise が reject されること。
- `pendingRequestUpdate` に当該 requestId のエントリが残らないこと。
- `pendingPrefix` がクリアされること。
- 上記を検証するテストがあること。

## 解決方法

未着手。
