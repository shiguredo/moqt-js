# 確立前 REQUEST_ERROR で bidi ストリームの送信方向が閉じない

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-request-error-stream-fin
- Polished: {YYYY-MM-DD}

## 目的

3 ループが確立前に REQUEST_ERROR を受信した場合、確立前 Promise を reject して `return` するだけで、専用 bidi ストリームの送信方向 (FIN) と受信方向 (cancel) を閉じない。`finally` は reader のロック解放と Map 削除のみを行うため、ストリームが片方向開いたままライブラリの管理外に残る。アプリは subscription オブジェクトを得られないため `unsubscribe()` で閉じることもできない。`refs/moq/draft-ietf-moq-transport-21.txt` §6.4.2.2 の「送るものが無くなった時点で FIN を送る」SHOULD に合わせて閉じる。

## 現状

- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` の `case MessageType.REQUEST_ERROR:` は、確立前 (`resolved === false`) に `reject(error); return;` で終わる。
- `finally` は state の更新・`streamReader.releaseLock()`・Map 削除のみで、`writer.close()` / `reader.cancel()` を呼ばない。
- GOAWAY / ピア FIN の経路は `namespaceCloseWriterQuiet` で送信方向を FIN するが、REQUEST_ERROR 経路では呼ばれない。
- 確立前の検証失敗 (先頭メッセージ不正・スコープ違反など) は `namespaceRejectAndCloseWithError` でセッションを閉じるため、ストリームはセッション終了で始末される。REQUEST_ERROR はセッションを閉じないため始末されない。
- GOAWAY 受信後の REQUEST_ERROR は読み取りを継続して保留中 REQUEST_UPDATE を reject する経路であり、本 issue の対象外とする。

## 設計方針

1. REQUEST_ERROR を受信して `reject` した後に、送信方向を `namespaceCloseWriterQuiet` で FIN し、受信方向を `reader.cancel()` で閉じる。cancel の失敗は既存の cancel ヘルパーと同様に無視する。
2. 順序は `reject` → FIN → reader の後始末とし、`reject` を先に置く既存方針を維持する。
3. `finally` の state 更新・Map 削除は現状のまま維持し、二重の releaseLock で例外にならないようにする (Publication は既に `releaseLock` を try/catch で包んでいる)。
4. 3 ループそれぞれで、確立前 REQUEST_ERROR の後に writer が閉じ、reader が解放されるテストを追加する。

## 完了条件

- 3 ループで確立前 REQUEST_ERROR を受信したとき、専用ストリームの送信方向が FIN され、受信方向が解放されること。
- 確立前 Promise の reject と Map の掃除が従来どおり実行されること。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。

## 参照

- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` (`src/session/namespaceLoops.ts`)
- `namespaceCloseWriterQuiet` (`src/session/namespaceLoops.ts`。送信方向の FIN)
- `src/session/namespaceLoops.test.ts` (`writerClosed` / `readableController` で検証するハーネス)
- `refs/moq/draft-ietf-moq-transport-21.txt` §6.4.2.2 / §9.2
