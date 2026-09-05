# sendRequestOnBidiStream の失敗時に pendingPublish / pendingFetch / pendingTrackStatus が残って孤児 Promise になる

- Created: 2026-08-29
- Updated: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-send-request-failure-pending-cleanup
- Polished: 2026-09-05

## 目的

`SessionImpl` のリクエスト送信系 (`publish()` / `subscribe()` / `fetch()` / `trackStatus()`) は、応答待ち Promise を pending マップへ登録した後に `sendRequestOnBidiStream()` で双方向ストリームを確立・送信する。送信が失敗した場合、pending エントリがセッション終了まで残り、誰にも返されない孤児 Promise がセッションクローズ時に reject されて unhandled rejection の素になる。リポジトリが確立した「ガードは pending 登録より前で失敗させる」不変条件 (`issues/closed/0426` の subscribe 構築移動、`src/session.ts` の fetch 側コメント、0393 の先例) を送信経路の失敗にも適用する。

## 現状

- `bidiSendRequestOnBidiStream()` (`src/session/bidi.ts`) は controlWriter 未初期化、`transport.createBidirectionalStream()` の失敗、`writer.write()` の失敗で throw し得る。
- `publish()` / `fetch()` / `trackStatus()` は「`pendingXxx.set` を含む Promise 作成 → `await this.sendRequestOnBidiStream(...)` → `void this.readXxxResponse(...)` → `return promise`」の順であり、送信が throw すると呼び出し元にはエラーが伝播する一方、内部 `promise` は返されないまま pending マップに残り、セッションクローズ時の `pending.reject(sessionClosedError)` でハンドラ不在の reject を受ける。`subscribe()` は `src/session.ts` で既に try/catch 掃除済み (FILL 実装の副産物) のため対象外。
- `writer.write()` 失敗時、`requestStreams.set` は成功経路でしか行われないため、作成済みの双方向ストリームが閉じられずにリークする。
- 0426 で `buildSubscribeParameters` を `pendingSubscribe.set` より前へ移動してローカル検証由来の throw は塞いだ (`src/session.ts`) が、`sendRequestOnBidiStream` 自体の失敗経路は依然として残っている。

## 設計方針

- 未対応の 3 件 (`publish()` / `fetch()` / `trackStatus()`。`subscribe()` は対応済みで本 issue では変更しない) で送信失敗時の掃除を追加する。`publish()` は `buildPublishParameters` / `buildPublishTrackProperties` / `encodePublishPayload` が `pendingPublish.set` の後にあり throw し得るため、構築・encode を `pendingPublish.set` より前へ移動する（`subscribe()` の `buildSubscribeParameters` 前倒し・`fetch()` の `buildFetchParameters` 前倒しと同形）。`trackStatus()` の `buildTrackStatusParameters` は throw しないが、`encodeTrackStatusPayload` 以降は共通化のため同一 try 範囲に含める。移動後に残る `encode` + `sendRequestOnBidiStream` の呼び出しを try/catch で囲み、失敗時は対応する pending マップ (`pendingPublish` / `pendingFetch` / `pendingTrackStatus`) の該当エントリを削除してから元のエラーを再 throw する。削除された孤児 Promise は以後 reject されず unsettled のまま GC 対象となり、ハンドラ不在の reject は発生しない。
- `bidiSendRequestOnBidiStream()` 側は `writer.write()` 失敗時に作成済みストリームを RESET で閉じてから throw する。手順は `stream.readable.cancel()` による受信方向の取消しと `writer.abort()` による送信方向のリセットとし（`bidiCancelSubscription` / `bidiCancelFetch` と同形、FIN である `writer.close()` は使わない）、`writer.releaseLock()` の順序に注意する。`requestStreams` の登録前失敗のため `requestStreams` 側の掃除は不要であることをコメントで残す。
- Promise 作成・pending 登録を `sendRequestOnBidiStream` 成功後へ移す案は採らない (登録とレスポンス読み取り開始の間に受信が差し込む余地を作らないための現状の順序を維持する。上記 try/catch 掃除で同等の保証を得る)。
- 範囲は送信に `sendRequestOnBidiStream` を使うメソッドに限定する。bidi 系 unsubscribe / REQUEST_UPDATE 経路の掃除 (0432 / 0433 系) は別 issue の管轄であり混在させない。

## 完了条件

- `sendRequestOnBidiStream` が throw する状況 (controlWriter 未初期化で作成直後に閉じる等、実装可能な再現経路) で `publish()` / `fetch()` / `trackStatus()` を呼び、`pendingPublish` / `pendingFetch` / `pendingTrackStatus` に該当 requestId のエントリが残らないこと。`subscribe()` は対応済みのため変更なしの回帰ガードとして同条件でエントリ残留なしを確認すること。
- 同じ状況で呼び出し元は送信エラーを受け取り、セッションを `close()` しても孤児 Promise の reject による unhandled rejection が発生しないこと (`process.on("unhandledRejection")` 検出パターンで検証する。`src/session.test.ts` の update() fire-and-forget テストが同パターン)。
- `writer.write()` 失敗時に作成済みストリームが RESET で閉じられること（`stream.readable.cancel()` と `writer.abort()` の呼び出しを注入 transport で観測する）。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- 関連: `issues/closed/0426-bug-absoluterange-end-group-overflow.md` (送信前検証の pending 登録前移動。本 issue は同一不変条件の送信経路版)
- 関連: `issues/closed/0432-bug-reset-path-pending-request-update-leak.md` / `issues/closed/0433-bug-bidi-unsubscribe-pending-update-cleanup.md` (REQUEST_UPDATE の pending 掃除。別経路のため本 issue では扱わない)

## 解決方法

未着手。
