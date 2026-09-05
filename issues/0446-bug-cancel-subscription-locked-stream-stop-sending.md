# bidiCancelSubscription / bidiCancelFetch がロック中の readable.cancel() で STOP_SENDING を送出できない

- Created: 2026-08-31
- Updated: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-cancel-subscription-locked-stream-stop-sending
- Polished: {YYYY-MM-DD}

## 目的

購読・フェッチの解除 (`unsubscribe()` / FETCH キャンセル) が、読み取りループにロックされた `readable` に対して `cancel()` を試みて TypeError になるため、STOP_SENDING がワイヤに出ない状態を修正する。§5.1 の手順 (STOP_SENDING による終了) / §5.2 の MUST が実質達成されていない。

## 現状

- `bidiCancelSubscription` (`src/session/bidi.ts`) は「WebTransport では `readable.cancel()` が STOP_SENDING 相当」とコメントし、`await streamInfo.stream.readable.cancel("subscription cancelled")` → `streamInfo.writer.abort(...)` の順で両方向を閉じる設計になっている。
- しかし受信 PUBLISH 由来の subscriber は、`handleIncomingBidirectionalStream` (`src/session.ts`) が取得した `subReader` で readable をロックしたまま `runPublishStreamSubLoop` の読み取りループに入っている。W3C Streams 仕様ではロック中の `ReadableStream.cancel()` は TypeError で reject するため、`cancel()` は失敗し、後続の `writer.abort()` にも到達しない (try/catch で握り潰されローカルの Map 掃除は走る)。結果としてワイヤには STOP_SENDING も RESET も出ず、ピアは配信を継続する。
- 自前 SUBSCRIBE 由来の subscriber も `bidiReadRequestStreamMessages` が reader をロックするため、解除時にループ生存中なら同じ構造になる。
- `bidiCancelFetch` (`src/session/bidi.ts`) は FETCH 用に同じコードパターンを持つが、FETCH の読み取り (`processFetchObjects`) はデータストリーム側であり、リクエストストリームの reader をロックする経路があるかを実装時に確定する。
- 変更対象: `src/session/bidi.ts` (`bidiCancelSubscription` / 必要に応じて `bidiCancelFetch`)、`src/session.ts` (reader ロックの所有をまたぐ設計にする場合)、`src/session/bidi.test.ts` / `src/session.test.ts` (テスト)、`CHANGES.md`。

## 設計方針

- Streams 仕様上、ロック中の cancel は不可能。`requestStreams` に保持している `stream` オブジェクトに対して cancel する方針のままなら、ロックを所有する読み取りループ側に解除要求を伝える構造が必要になる。選択肢は 2 つで、実装時に片方へ確定する:
  - (a) reader の `cancel()` をループ側で実行できるよう、解除要求を保持するフラグ / 待機機構を session 内部に置き、`unsubscribe()` はそれを設定してループの終了 (finally の解放済み期間) に cancel を実行する。STOP_SENDING が遅延して出る
  - (b) ループがロックしている reader を介して cancel する (reader 取得時に保持している `subReader.cancel()` 相当)。`reader.cancel()` はロック保持者から直接呼べるため、リクエストストリーム側の reader を `requestStreams` の管理下に置いて経由する
- 通知意味論は現行維持: 解除は自前起点なので error / end コールバックは呼ばない (`SubscriberImpl.unsubscribe` の docstring と同じ解釈)。
- 0445 (PUBLISH_OK 書き込み失敗の後始末) とは別目的 (0445 は exit 経路の掃除、本 issue は解除時のワイヤ送出) なので同時に直さない。

## 完了条件

- 受信 PUBLISH 由来の subscriber について、読み取りループ生存中に `unsubscribe()` を呼んだ場合、ピアへ STOP_SENDING に相当する `cancel()` が実際に到達すること (テストで `cancel` の成功を観測できること。`{ readable: { cancel() { ... } } }` のような注入でなく、実ストリームのロック解除経路をまたぐことを検証する)。
- 自前 SUBSCRIBE 由来の subscriber の `unsubscribe()` でも同じく STOP_SENDING が到達すること。
- `writer.abort()` が現行どおり後続で実行されること (GOAWAY 済みで abort が reject するケースの握り潰しは維持)。
- `bidiCancelFetch` を対象に含めるかの方針が確定し、対象にするなら FETCH 解除でも STOP_SENDING が到達すること。
- ローカル側の Map 掃除 (`requestStreams` / `subscribers` / `subscribersByAlias`) の挙動は現状維持であること (回帰ガード)。
- 上記を検証するテストが実 W3C ストリーム注入方式であること (モック禁止)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1 (Subscriptions: 「The subscriber terminates a subscription in the Pending (Subscriber) or Established states by sending STOP_SENDING.」)
- draft-ietf-moq-transport-20 §5.2 (Fetch State Management: 「It MUST send STOP_SENDING for the bidi request stream.」なお data stream は MAY)
- W3C Streams Standard (ReadableStream.cancel: locked 場合は TypeError で reject)
- 関連: `issues/0445-bug-publish-ok-write-failure-cleanup.md` (受信 PUBLISH 処理の別経路の後始末。本 issue とは目的が異なる)
- 関連: `issues/closed/0433-bug-bidi-unsubscribe-pending-update-cleanup.md` (bidi unsubscribe の掃除。あれは応答待ち REQUEST_UPDATE の Promise 掃除が目的で、ワイヤへの STOP_SENDING 送出は扱っていないため別問題)
