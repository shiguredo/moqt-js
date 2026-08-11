# GOAWAY 受信時に応答待ちの REQUEST_UPDATE がクリーンアップされない

- Created: 2026-08-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-goaway-pending-request-update-cleanup
- Polished: {YYYY-MM-DD}

## 目的

GOAWAY 受信前に送信済みで応答待ちの REQUEST_UPDATE の Promise (`pendingRequestUpdate`) が、ピアがストリームを FIN で閉じた場合に未解決のまま残る問題を解消する。

## 現状

- GOAWAY ハンドラ (`bidiReadRequestStreamMessages` の GOAWAY ケース / `runPublishStreamSubLoop` の GOAWAY ケース) は `pendingRequestUpdate` を一切触らない。
- GOAWAY 前に送信した REQUEST_UPDATE の応答 (REQUEST_OK / REQUEST_ERROR) は、GOAWAY 後の読み取り継続中に受信すれば既存の REQUEST_OK / REQUEST_ERROR ケースで解決される。しかしピアが応答を送らずに FIN でストリームを閉じた場合、`pendingRequestUpdate` のエントリはセッション終了まで残り、`subscriber.update()` の Promise が未解決のままになる。
- 0372 の `bidiSendRequestUpdate` に追加した GOAWAY 送信ガードは「新規送信」のみを防ぎ、既存の pending エントリは対象外。

## 設計方針

- GOAWAY 受信時に、当該 requestId を targetRequestId とする `pendingRequestUpdate` のエントリを REQUEST_ERROR (GOING_AWAY) 相当で reject する。
- 読み取り継続中に後続の REQUEST_OK / REQUEST_ERROR が届いた場合に二重解決しないよう、reject 済みエントリは削除する (既存の REQUEST_ERROR ケースの coalescing 処理と同様)。

## 完了条件

- GOAWAY 受信時に、該当 requestId の pendingRequestUpdate が reject され、エントリが削除されること。
- `subscriber.update()` の Promise が GOAWAY 後に解決されること (未解決のまま残らないこと)。
- テストがあること。

## 解決方法

未着手。
