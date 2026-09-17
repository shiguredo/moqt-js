# FETCH リクエストストリーム上の REQUEST_UPDATE を検出しない

- Created: 2026-09-15
- Completed: 2026-09-17
- Branch: feature/fix-fetch-stream-request-update
- Polished: 2026-09-17

## 目的

draft-ietf-moq-transport-21 §9.5 は、REQUEST_UPDATE を受け取れるのは「リクエストの送信者」と「PUBLISH で確立した購読の subscriber」の 2 ケースのみとし、それ以外は PROTOCOL_VIOLATION で閉じる MUST を定める。FETCH では moqt-js が FETCH を送る側 (requester) であり、ピアは responder である。responder が FETCH 応答ストリームで REQUEST_UPDATE を送ることは 2 ケースのいずれにも該当しないが、FETCH_OK 受理後に読み取りが継続されないため、逸脱したピアの REQUEST_UPDATE を検出できない。

## 現状

- `bidiReadRequestStreamMessages` (`src/session/bidi.ts`) の呼び出しは `bidiReadPublishResponse` の `handleOk` と `bidiReadSubscribeResponse` の `handleOk` の 2 箇所のみで、`bidiReadFetchResponse` の `handleOk` にはない
- FETCH_OK 受理後もストリームは `requestStreams` に残るが、以降メッセージを読まない。`bidiReadFetchResponse` の `handleOk` はエントリを削除せず、`SessionImpl.handlePeerFetchStreamReset` のコメントも「bidi リクエストストリーム (`requestStreams`) は FIN 経路と同じく削除しない」と明記する。最初の応答を読む `bidiReadResponseFromBidiStream` は `finally` で `reader.releaseLock()` するため、以降ストリームを読む主体がいない
- `Fetcher` (`src/fetcher.ts`) の公開 API は `state` / `endOfTrack` / `endLocation` / `trackProperties` / `cancel()` のみで更新 API がなく、moqt-js は FETCH の REQUEST_UPDATE を送らない。`bidiSendRequestUpdate` は `SubscriberImpl` のみを受け付け、`bidiCancelFetch` のコメントも「FETCH を対象とする REQUEST_UPDATE 送信経路は本実装に存在しない」と明記する
- §9.5 の 2 ケースに照らすと、FETCH の responder からの REQUEST_UPDATE は該当しない
- 読み取りループの role は `"publish" | "subscribe"` の 2 値のみで、FETCH 用の role がない。`bidiPreflightRequestUpdate` の想定外 REQUEST_UPDATE 判定は `role === "subscribe"` を条件にし、`bidiHandlePublishStateNotify` は `role === "subscribe"` だけを受理する
- `closeOldRequestStreamOnGoaway` は doc コメントで「fetcher: established FETCH に読み取りループは存在しないため対象外」とし、`session.publishers` と `session.subscribers` しか見ない
- 確立前 (最初の応答が GOAWAY) の FETCH は `bidiReadFetchResponse` の `handleGoaway` が `pending.impl.goawayCallback` を呼ぶが、確立後の GOAWAY は読み取り自体が無いため到達しない

draft-ietf-moq-transport-21 §9.5:

> An endpoint that receives a REQUEST_UPDATE other than in the two cases above MUST close the session with a PROTOCOL_VIOLATION.

draft-ietf-moq-transport-21 §9.10:

> PUBLISH_STATE_NOTIFY applies only to subscriptions, and is sent only by the publisher. An endpoint that receives a PUBLISH_STATE_NOTIFY for any other request type, or from the subscriber, MUST close the session with a PROTOCOL_VIOLATION.

draft-ietf-moq-transport-21 §9.11:

> A publisher responds to a FETCH request with either a FETCH_OK or a REQUEST_ERROR message. The publisher creates a new unidirectional stream that is used to send the Objects. The FETCH_OK or REQUEST_ERROR can come at any time relative to object delivery.

## 設計方針

- `bidiReadFetchResponse` の `handleOk` で FETCH_OK を受理した後、`fireFetcherReadyCallbacks` の後に `void bidiReadRequestStreamMessages(...)` を起動し、当該双方向ストリームの読み取りを継続する
- `bidiReadRequestStreamMessages` の role に `"fetch"` を追加し、role に依存する分岐すべてで fetch の期待動作を定義する。既存の `"publish"` / `"subscribe"` の流用は誤動作するため使わない (根拠は確定事項)
- REQUEST_UPDATE を受信したら §9.5 の MUST に従い PROTOCOL_VIOLATION で閉じる
- FIN と 2 通目 GOAWAY の検出と後始末は publish / subscribe の読み取りループと同じ仕組みを使い、fetch 固有の差分だけを確定事項に列挙する

### 確定事項

#### 読み取りを継続する場所と正常系への影響

- 読み取りループの起動は `bidiReadFetchResponse` の `handleOk` の末尾、`fireFetcherReadyCallbacks(session, requestId)` の直後に `void` で行う。`requestStreams` のエントリは FETCH_OK 受理後も残るため、`bidiReadRequestStreamMessages` は `registeredEntry` を引ける
- 読み取りループが読むのは双方向ストリーム上の制御メッセージだけである。Fetch Object は §9.11 の「The publisher creates a new unidirectional stream that is used to send the Objects.」により単方向データストリームを流れ、`SessionImpl.handleIncomingStream` が `FetchHeaderType` を判定して `fetchers` から fetcher を引く別経路で処理する。したがって Object のバイト列を制御メッセージとして解釈する危険はない。`ControlStreamReader` も `bidiSendRequestOnBidiStream` がリクエストごとに新規作成し、データストリームとは共有しない
- FETCH の正常系は「FETCH_OK は双方向ストリーム、Fetch Object とその終端 FIN は単方向データストリーム」である。§9.12 は FETCH_OK より先に Object が届くことを認めるため、両者の順序は固定されない。データストリームの FIN / RESET_STREAM は `SessionImpl` の `handleEnd` / `handlePeerFetchStreamReset` が処理し、`fetchers` の登録と削除の挙動を変えない
- 双方向ストリームの FIN は §6.4.2.2 の SHOULD であり、正常系で必ず届くとは限らない。届かなくても読み取りループはピア FIN / RESET_STREAM / セッション終了まで継続し、`requestStreams` のエントリもセッション終了まで残る。`bidiCancelFetch` は `streamInfo.reader !== undefined` のときに `reader.cancel()` を使う分岐を既に持つため、アプリの `Fetcher.cancel()` で読み取りループを停止できる
- publish ロールの流用が誤動作する根拠: `bidiPreflightRequestUpdate` の想定外 REQUEST_UPDATE 判定は `role === "subscribe"` を条件にするため、publish ロールでは fetch の requestId が `session.publishers` に無いことを理由に REQUEST_ERROR (INTERNAL_ERROR, "publisher not found for request update") を応答し、さらに `bidiTerminatePublishSubscriptionWithUpdateFailed` が PUBLISH_DONE (UPDATE_FAILED) を FETCH ストリームへ書き込む。§9.5.1 が定める FETCH の失敗機構は PUBLISH_DONE ではなく FETCH データストリームの reset であり、§9.5 の MUST (PROTOCOL_VIOLATION) にも反する
- subscribe ロールの流用が誤動作する根拠: `bidiHandlePublishStateNotify` は subscribe ロールを受理するため、FETCH ストリーム上の PUBLISH_STATE_NOTIFY が §9.10 の MUST に反して受理される。さらに `bidiPreflightRequestUpdate` は GOAWAY 受信済みの subscribe ロールの REQUEST_UPDATE を無視するため、完了条件を無条件には満たせない

#### fetch ロールで受信しうるメッセージの扱い

- REQUEST_UPDATE: 無条件に PROTOCOL_VIOLATION で閉じる (§9.5 MUST)。GOAWAY 受信済みでも同じ扱いにする (subscribe ロールの意図的な逸脱には揃えない。他 issue との関係を参照)。`bidiPreflightRequestUpdate` は現行の判定が `role === "subscribe" && !session.goawayReceivedOnRequestStreams.has(requestId)` であり、role の一般化だけで済ませると GOAWAY 受信済みの fetch が後段の GOAWAY 分岐 (`if (session.goawayReceivedOnRequestStreams.has(requestId))` の中の `role === "publish"` 判定) に落ちて `"break"` を返し、REQUEST_UPDATE を無視する。fetch を閉じる判定は `goawayReceivedOnRequestStreams` に依存させず、GOAWAY 分岐より前に置く。subscribe ロールの「GOAWAY 受信済みなら無視する」という現行の逸脱と、publish ロールの REQUEST_ERROR (GOING_AWAY) 応答は現行どおり維持する
- PUBLISH_STATE_NOTIFY: PROTOCOL_VIOLATION で閉じる (§9.10 MUST)。`bidiHandlePublishStateNotify` の `role !== "subscribe"` ガードで満たされるため分岐の追加は不要だが、エラー文言が publish 固定であるため、fetch でも実態に合う文言にする
- ピア FIN: publish ロールの `receivedFin` による削除遅延は適用しない。自方向を FIN で閉じて (`closeRequestStreamWriter`。§6.4.2.2 の SHOULD) 読み取りを終了し、`finally` で `requestStreams` から削除する。subscription 向けの失敗通知 (`notifySubscriberFailure`) は呼ばない。FETCH に PUBLISH_DONE は無く、responder の FIN は正常完了である
- 1 通目 GOAWAY: `closeOldRequestStreamOnGoaway` に fetcher の分岐を追加し、`fetcher.goawayCallback` を呼んだうえで自方向を FIN で閉じ、読み取りは継続する (§9.2 SHOULD)。あわせて同関数の「fetcher: established FETCH に読み取りループは存在しないため対象外」の記述を更新する
- 2 通目 GOAWAY: `validateNoDuplicateGoawayOnRequestStream` をそのまま使い PROTOCOL_VIOLATION で閉じる (§9.2 MUST)。同関数は requestId だけを見るため fetch でも変更なしで機能する
- PUBLISH_DONE / REQUEST_OK / REQUEST_ERROR: 既存の switch の扱いをそのまま通す。fetch には対応する `subscribers` のエントリも `pendingRequestUpdate` も無いため、デコードと検証だけを行って状態を変えず読み取りを継続する
- 未知のメッセージ型: 既存の `default` 分岐で PROTOCOL_VIOLATION になる
- 読み取り失敗 (ピアの RESET_STREAM 等): 既存の `handleRequestStreamReadError` を通す。fetch は「publish 以外」の分岐に落ちるが、購読も保留中の更新も無いため通知は発生せず、現行と同じ結果になる

#### FETCH_OK と同一チャンクに連結したメッセージ

- `bidiDispatchResponse` は最初のチャンクで読んだ 2 通目以降を `context.remainingMessages` に保持する。`ControlStreamReader` は取り出したメッセージをバッファから削除するため、渡さなければ復元できない。FETCH では `context.remainingMessages` を読み取りループの初期メッセージとして先頭から処理し、FETCH_OK と同一チャンクの REQUEST_UPDATE と GOAWAY も取りこぼさない (`bidiContinueReadingForDuplicateGoaway` が `initialMessages` を先頭から走査するのと同じ扱い)。この位置の GOAWAY は 1 通目であり、重複判定は 1 通目を `goawayReceivedOnRequestStreams` に登録した後に行う
- publish / subscribe 経路が `context.remainingMessages` を渡していない点は本 issue のスコープ外とし、変更しない

#### 他 issue との関係

- `issues/0614-bug-max-request-updates-receive-enforcement.md` は「受信 REQUEST_UPDATE の 2 経路」を前提にする。fetch ロールは §9.5 MUST で即座に閉じるため、MAX_REQUEST_UPDATES の未応答数には数えない。0614 の実装時にこの前提が変わる場合は 0614 側を更新する
- `issues/0618-change-receive-response-conformance.md` が扱う「GOAWAY 受信後の subscribe ロールの REQUEST_UPDATE の扱い」と「確立後の 2 通目 REQUEST_OK の扱い」は fetch ロールには適用しない。fetch ロールでは GOAWAY 受信済みでも REQUEST_UPDATE は PROTOCOL_VIOLATION にする。0618 の「pending がなく、自 endpoint が REQUEST_UPDATE を送っていない」場合に限り PROTOCOL_VIOLATION とする規則は fetch でも条件が成立してしまうため、0618 の実装時に fetch ロールを含めるか除外するかを 0618 側で決める。本 issue は現行の switch の扱い (REQUEST_OK は状態を変えず読み取りを継続) を維持する

## 完了条件

- FETCH 応答ストリーム上の REQUEST_UPDATE が PROTOCOL_VIOLATION になる。FETCH_OK と同一チャンクに連結された場合も同じ
- GOAWAY 受信済みでも FETCH 応答ストリーム上の REQUEST_UPDATE が PROTOCOL_VIOLATION になる
- FETCH 応答ストリーム上の PUBLISH_STATE_NOTIFY が PROTOCOL_VIOLATION になる
- FETCH の正常系が変わらない。Fetch Object とその終端 FIN は単方向データストリーム側で処理され、双方向ストリームの読み取りループの影響を受けない。`fetchers` の登録と削除の挙動も変わらない
- ピア FIN で自方向が FIN で閉じられ、`requestStreams` のエントリが削除される
- 2 通目 GOAWAY で PROTOCOL_VIOLATION になる
- 確立後の GOAWAY で `Fetcher` の `goawayCallback` が呼ばれる
- `Fetcher.cancel()` が読み取りループを停止できる (`bidiCancelFetch` の既存分岐が機能する)
- テストがある。実ストリームと実 Map で構成し (`src/testSupport/bidi.ts` の既存ヘルパーを利用する)、モックやスタブは追加しない
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

設計方針のとおりに実装した。変更は `src/session/bidi.ts` に閉じており、
`SessionImpl` (`src/session.ts`) と `Fetcher` (`src/fetcher.ts`) の公開 API は
変更していない。

- `bidiReadRequestStreamMessages` の role を `"publish" | "subscribe" | "fetch"` に
  広げ、型に `BidiRequestStreamRole` の名前を付けた。role 依存の分岐は
  `bidiPreflightRequestUpdate` (REQUEST_UPDATE) と
  `bidiHandlePublishStateNotify` (PUBLISH_STATE_NOTIFY)、ピア FIN の後始末の 3 か所で
  あり、いずれにも fetch の期待動作を定義した。
- `bidiReadFetchResponse` の `handleOk` で `fireFetcherReadyCallbacks` の直後に
  `void bidiReadRequestStreamMessages(..., "fetch", context.remainingMessages)` を
  起動した。`context.remainingMessages` を初期メッセージとして先頭から処理するため、
  FETCH_OK と同一チャンクに連結された REQUEST_UPDATE / PUBLISH_STATE_NOTIFY /
  GOAWAY も取りこぼさない。`bidiReadRequestStreamMessages` に
  `initialMessages` 引数を追加し、`bidiHandleRequesterFinForResponderClose` /
  `bidiProcessRequestStreamMessages` / `bidiHandleRequestUpdateMessage` /
  `bidiHandleRequestStreamGoaway` へ switch 本体を切り出した (挙動は変えていない)。
- fetch ロールの REQUEST_UPDATE は `bidiPreflightRequestUpdate` の先頭で
  `goawayReceivedOnRequestStreams` を見ずに PROTOCOL_VIOLATION で閉じる。
  判定を GOAWAY 分岐 (`"break"` を返す) より前に置いたため、GOAWAY 受信済みでも
  検出できる。subscribe ロールの「GOAWAY 受信済みなら無視する」逸脱と publish
  ロールの REQUEST_ERROR (GOING_AWAY) 応答は現行どおり維持している。
- fetch ロールの PUBLISH_STATE_NOTIFY は既存の `role !== "subscribe"` ガードで
  閉じる。エラー文言を `unexpected PUBLISH_STATE_NOTIFY on publish stream` から
  `unexpected PUBLISH_STATE_NOTIFY on ${role} stream` に変え、fetch でも実態に
  合うようにした。
- ピア FIN では publish ロールの削除遅延を適用せず、`closeRequestStreamWriter` で
  自方向を FIN で閉じ、`finally` の `requestStreams.delete` でエントリを削除する。
  `notifySubscriberFailure` は呼ばない (FETCH に PUBLISH_DONE は無く、responder の
  FIN は正常完了である)。
- `closeOldRequestStreamOnGoaway` に fetcher の分岐を追加し、
  `fetcher.goawayCallback` を呼んで `closeRequestStreamWriter` で自方向を FIN で
  閉じる。読み取りは 2 通目 GOAWAY の検出のため継続する。同関数の
  「fetcher: established FETCH に読み取りループは存在しないため対象外」という
  記述を実装に合わせて更新した。
- `handleRequestStreamReadError` は fetch を「publish 以外」の分岐に通す。
  購読も保留中の更新も無いため通知は発生せず、セッションも閉じない。
- 2 通目 GOAWAY は既存の `validateNoDuplicateGoawayOnRequestStream` で
  PROTOCOL_VIOLATION になる (requestId だけを見るため変更不要)。
- `bidiCancelFetch` は変更していない。確立後は読み取りループが
  `streamInfo.reader` を登録するため、既存の `reader.cancel()` 分岐が機能して
  読み取りループを停止できる。
- `SessionImpl.handlePeerFetchStreamReset` は変更していない。データストリームの
  FIN / RESET_STREAM の経路は双方向ストリームの読み取りループと独立しており、
  `fetchers` の登録と削除の挙動は変わらない。
- 既存テストの期待値のうち、`bidiHandlePublishStateNotify` のエラー文言に依存する
  ものは無かった (テストは `SessionErrorCode` のみを見ている) ため、
  テストの修正は不要だった。

検証:

- `src/testSupport/bidi.ts` に `createFetchReadTestContext` を追加した。実 W3C
  ストリーム (ReadableStream / WritableStream) と実 Map で FETCH_OK の応答
  ストリームを構成し、FETCH_OK と同一チャンクへ連結するメッセージを
  `additionalMessages` で注入できる。モックやスタブは使っていない。
- `src/session/bidiFetchRequestStreamMessages.test.ts` を新規作成し 17 件追加した。
  FETCH 応答ストリーム上の REQUEST_UPDATE (別チャンク / FETCH_OK と同一チャンク /
  GOAWAY 受信済み)、未応答数に数えないこと、PUBLISH_STATE_NOTIFY、
  ピア FIN の自方向 FIN と削除、2 通目 GOAWAY、確立後 GOAWAY の goawayCallback、
  `Fetcher.cancel()` による読み取り停止、REQUEST_OK / PUBLISH_DONE / 未知型 /
  RESET_STREAM の扱い、正常系の `fetchers` の登録と削除、FETCH_OK の反映を固定する。
- `vp check` / `tsc --noEmit` / `vp test run` (103 files / 2294 tests) /
  `vp run build` がすべて通ることを確認した。

## 参照

- draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE)
- draft-ietf-moq-transport-21 §9.11 (FETCH)
- draft-ietf-moq-transport-21 §9.12 (FETCH_OK)
- draft-ietf-moq-transport-21 §6.4.2.2 (Graceful Request Stream Closure)
- draft-ietf-moq-transport-21 §9.2 (GOAWAY)
- draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY)
- draft-ietf-moq-transport-21 §3.2.1 (Fetch State Management)
- `issues/0614-bug-max-request-updates-receive-enforcement.md` (受信 REQUEST_UPDATE の経路を扱う。fetch ロールは対象外)
- `issues/0618-change-receive-response-conformance.md` (GOAWAY 後の subscribe ロールと 2 通目 REQUEST_OK の扱いを扱う。fetch ロールは対象外)
- `issues/closed/0372-moqt-draft-19-duplicate-goaway-on-request-stream-undetected.md` (established FETCH の GOAWAY をスコープ外として先送りした先行 issue)
