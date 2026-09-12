# 確立前 REQUEST_ERROR で bidi ストリームの送信方向が閉じない

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-request-error-stream-fin
- Polished: 2026-09-12

## 目的

3 ループが確立前に REQUEST_ERROR を受信した場合、確立前 Promise を reject して `return` するだけで、専用 bidi ストリームの送信方向 (FIN) と受信方向 (`reader.cancel()`) を閉じない。`finally` は reader のロック解放と Map 削除のみを行うため、送信方向が開いたままライブラリの管理外に残る。アプリは subscription オブジェクトを得られないため `unsubscribe()` で閉じることもできない。`refs/moq/draft-ietf-moq-transport-21.txt` §6.4.2.2 の「送るものが無くなり将来の REQUEST_UPDATE に応答する必要も無いときは速やかに FIN を送る」SHOULD に従って送信方向を FIN し、§6.4.2.3 の「要求をキャンセルする場合は開いたままの方向を RESET_STREAM / STOP_SENDING で閉じる」に従って受信方向を cancel する。

## 現状

- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` の `case MessageType.REQUEST_ERROR:` は、確立前 (`resolved === false`) に `reject(error); return;` で終わる。
- `finally` は state の更新・`streamReader.releaseLock()`・Map 削除のみで、`writer.close()` / `reader.cancel()` を呼ばない。
- GOAWAY / ピア FIN の経路は `namespaceCloseWriterQuiet` で送信方向を FIN するが、REQUEST_ERROR 経路では呼ばれない。
- 確立前の検証失敗 (先頭メッセージ不正・スコープ違反など) は `namespaceRejectAndCloseWithError` でセッションを閉じるため、ストリームはセッション終了で始末される。REQUEST_ERROR はセッションを閉じないため始末されない。
- GOAWAY 受信後の REQUEST_ERROR は読み取りを継続して保留中 REQUEST_UPDATE を reject する経路であり、本 issue の対象外とする。

## 設計方針

1. REQUEST_ERROR を受信して `reject` した後に、送信方向を `namespaceCloseWriterQuiet` で FIN し、受信方向を `reader.cancel()` (STOP_SENDING 相当) で閉じる。cancel は `finally` の `releaseLock()` より前に実行する (解放後の cancel は無効になるため)。cancel の失敗は既存の `cancelStreamQuiet` と同様に無視し、cancel が throw しても確立前 Promise の reject と Map の掃除が従来どおり完了するようにする。
2. 順序は `reject` → FIN → cancel とし、`reject` を先に置く既存方針を維持する。
3. `finally` の state 更新・Map 削除は現状のまま維持し、二重の `releaseLock()` で例外にならないようにする (Publication は既に try/catch で包んでいる。namespace / tracks も cancel 失敗時に備えて同じ扱いにする)。
4. 3 ループそれぞれで、確立前 REQUEST_ERROR の後に writer が閉じ、reader が cancel されるテストを追加する。現行ハーネスは `writerClosed` しか公開しておらず reader の cancel を観測できないため、観測できるようにする (cancel 済みの readable への `readableController.enqueue` が失敗することの確認など)。
5. 確立後 (resolved=true) の REQUEST_ERROR と、bidi の SUBSCRIBE / PUBLISH / FETCH が REQUEST_ERROR で writer を閉じない既存挙動は本 issue の対象外とする (本 issue は確立前の 3 ループに限る)。

## 完了条件

- 3 ループで確立前 REQUEST_ERROR を受信したとき、専用ストリームの送信方向が FIN され、受信方向が `reader.cancel()` で閉じられること (`finally` の `releaseLock()` だけでは満たさない。テストは cancel を観測できる形で検証する)。
- 確立前 Promise の reject と Map の掃除が従来どおり実行されること (cancel の失敗で reject の内容が変わらないこと)。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。

## 参照

- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` (`src/session/namespaceLoops.ts`)
- `namespaceCloseWriterQuiet` (`src/session/namespaceLoops.ts`。送信方向の FIN)
- `cancelStreamQuiet` (`src/session/stream.ts`。reader.cancel の失敗を無視するヘルパー)
- `src/session/namespaceLoops.test.ts` (`writerClosed` / `readableController` で検証するハーネス)
- `refs/moq/draft-ietf-moq-transport-21.txt` §6.4.2.2 (Graceful Request Stream Closure) / §6.4.2.3 (Request Cancellation and Rejection) / §9.2 (GOAWAY 受信後の REQUEST_ERROR は対象外である根拠)
