# sessionNotifyErrorIfActive が状態だけを閉じて保留中のリクエストを reject しない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-session-notify-error-pending
- Polished: 2026-11-10

## 目的

`src/session/lifecycle.ts` の `sessionNotifyErrorIfActive` は、受信ループの読み取りエラーが `isSessionClosedError` に当たると `sessionState` を `"closed"` にするだけで返り、`sessionMarkRequestObjectsClosed` も `sessionRejectPendingRequests` も呼ばない。以降の `sessionClose` は `sessionState === "closed"` で早期 return する。そのため、保留中のリクエストの Promise は、自分の await (ストリームの作成 / 書き込み / 応答の読み取り) が完了せず、かつ `transport.closed` も settle しない場合に settle しない (request stream の REQUEST_UPDATE の応答待ちは、読み取りがエラーで完了しても reject されない)。closed の 0934 が残した課題 (「`sessionNotifyErrorIfActive` で状態だけが閉じ、かつ await が解決しない場合は Promise が settle しない」) である。ライブラリとして「Session が閉じたら未確立の待ちは settle する」契約を、`transport.closed` の挙動に頼らずに保証する。

先に open の 0933 (PR #543。マージ後は `issues/closed/` に移る) を対応する必要がある。0933 は `sessionRejectPendingRequests` に subscribeNamespace / subscribeTracks の待ちを加え、`docs/LOW_LEVEL_API.md` に購読系の「Session 終了時の契約」を足すため、本 issue の変更はその後の `sessionRejectPendingRequests` と docs を前提にする。

## 現状

- `sessionNotifyErrorIfActive` は、`session.sessionState !== "connected"` なら何もせずに返る。`isSessionClosedError(error)` が真のときだけ `sessionState` を `"closed"` にして返り、`sessionMarkRequestObjectsClosed` も `sessionRejectPendingRequests` も呼ばない。それ以外 (アプリコールバックの throw など) は `callbacks.error` に通知し、Session を閉じない (closed の 0543 の方針)
- 呼び出し元は次の 5 関数である。`src/session/dataStreamIncoming.ts` と `src/session/incomingPublish.ts` は `session.notifyErrorIfActive` (`src/session.ts` の `SessionImpl.notifyErrorIfActive`) を経由する
  - `src/session/lifecycle.ts` の `sessionStartControlMessageLoop`。`source` プロパティが `"session"` のエラー (WebTransportError に限らない) は手前で除外するため、閉じる分岐に届くのは文字列の判定で当たるエラーだけである
  - `src/session/dataStreamIncoming.ts` の `dataStreamStartIncomingStreamLoop` / `dataStreamStartDatagramLoop`
  - `src/session/incomingPublish.ts` の `incomingPublishStartBidiStreamLoop` / `incomingPublishReadFirstBidiMessage`
- W3C WebTransport の cleanup は、closeInfo があれば `closed` を resolve して受信ストリーム (`incomingUnidirectionalStreams` / `incomingBidirectionalStreams` / `incomingDatagrams`) を close し、無ければ同じ `error` で `closed` を reject して受信ストリームも error にする。接続エラーによる終了の `error` は `source` が `"session"` の WebTransportError である。上の 3 つの受信ループは `done` で抜けるため、実ブラウザの正常終了ではこの分岐に入らず、主に入るのは failed の終了のときである。そのとき受け取る `error` は `transport.closed` を reject するのと同じものである
- Session の終了の後始末は、`src/session.ts` の `SessionImpl` のコンストラクタの `transport.closed` の処理が行う。`.then` は `markRequestObjectsClosed` の後に `rejectPendingRequests(new Error("session closed by peer"))` と `callbacks.close` を、`.catch` は受け取ったエラーで同じ後始末をする。この処理は状態に関係なく走り、`.then(...).catch(...)` の 2 段のため、受信ループの読み取りエラーの処理と順序が競合し得る
- `docs/LOW_LEVEL_API.md` の「通常の request stream」は、Promise は終了の理由 (自分からの `close()` では `"session closed"`、ピア起点の終了では `"session closed by peer"`、transport が failed で閉じた場合は `transport.closed` の reject のエラー) で 1 回だけ settle する、と定めている
- 窓ごとの現状は次のとおりである
  - 送信待ち (ストリームの作成 / 書き込みの await): closed の 0934 と 0890 で、await が完了した時点で状態が `"closed"` なら `"session closed"` で reject する (`src/session/requests.ts` の `requestsSendRequest`、`src/session/namespaces.ts` の `namespacesSendPublishNamespace`)。await が完了しない場合は settle しない
  - 最初の応答待ち (publish / subscribe / fetch / trackStatus): `src/session/bidi.ts` の `bidiDispatchResponse` は読み取りエラーを既定の `defaultBidiHandleError` で受け、そのエラーで reject する (`source: "session"` を含む)。ストリームの読み取りが error にも done にもならない場合だけ `transport.closed` まで残る
  - 確立後の REQUEST_UPDATE の応答待ち (`pendingRequestUpdate`): 自分側の request stream (`bidiReadRequestStreamMessages`) の更新待ちは、`handleRequestStreamReadError` がピアのストリームのエラーでない読み取りエラーでは reject しないため、`transport.closed` まで残る。受信 PUBLISH (`src/session/incomingPublish.ts` の `incomingPublishRunStreamSubLoop`) と subscribeNamespace / subscribeTracks (`namespaceLoops.ts` の `namespaceHandleSubscriptionReadError`) の更新待ちは、自分のストリームの読み取りエラーで `REQUEST_UPDATE_STREAM_CLOSED_MESSAGE` を理由に reject される
  - 登録済みで未確立の publication: 状態は `"pending"` のまま残り、`src/session/namespaceLoops.ts` の `createPublicationStreamHandlers` の `onReadError` が読み取りエラーで settle させ得る
- 「状態だけを閉じる経路」を前提に書かれたコメントがある: `requestsSendRequest` の手順 5 (「sessionRejectPendingRequests が pending を clear しない経路 (状態だけを閉じる経路) でも Promise を settle させるため」)、0933 の `namespacesSendSubscription` の手順 5、`dataStreamFinishFetchStream` の JSDoc (「条件付きで遷移する notifyErrorIfActive では active のまま残る」)。`lifecycle.ts` の `sessionMarkRequestObjectsClosed` / `sessionRejectPendingRequests`、`session.ts` の `SessionImpl.markRequestObjectsClosed` / `rejectPendingRequests`、`requestsSendRequest` と 0933 の `namespacesSendSubscription` の JSDoc は、終了の経路を自分の `close()` と `transport.closed` の 2 つだけ挙げている
- Node のテスト環境には WebTransportError のグローバルが無く、`isSessionClosedError` は文字列の判定 (`"session is closed"` / `"session closed"` を含むか) になる。既定のテスト用 transport の `closed` は settle しないが、`src/testSupport/bidi.ts` の `createTestWebTransport` (`resolveClosed` / `rejectClosed`) と、`src/session.test.ts` の `createHeldBidiStreamTransport` / `createPendingNamespaceTransport` (`closeFromPeer`) は `closed` を settle できる

## 設計方針

- `transport.closed` の処理の共通部分 (状態を `"closed"` にする → `sessionMarkRequestObjectsClosed` → `sessionRejectPendingRequests(理由)`) を `src/session/lifecycle.ts` のヘルパー (例: `sessionFinishTermination(session, reason)`) に切り出す。`transport.closed` の `.then` / `.catch` と、`sessionNotifyErrorIfActive` の `isSessionClosedError` の分岐の両方から呼ぶ。`callbacks.close` は closeInfo が要るため、従来どおり `transport.closed` の処理だけが呼ぶ。`transport.closed` の処理がヘルパーを直接呼ぶと、`SessionImpl` の private ラッパー `markRequestObjectsClosed` / `rejectPendingRequests` は参照が無くなり、`noUnusedLocals` で tsc が通らないため削除する (closed の 0589 と同じ扱い)
- `sessionNotifyErrorIfActive` で変えるのは `isSessionClosedError` が真の分岐だけである。理由は受け取った読み取りエラー (`error instanceof Error ? error : new Error(String(error))`) とし、`callbacks.error` / `callbacks.close` は呼ばない。`callbacks.error` の分岐 (アプリコールバックの throw など) は変えず、Session を閉じも reject もしない
- 理由を受け取ったエラーにするのは、この分岐に主に入る failed の終了では、そのエラーが `transport.closed` を reject するのと同じものであり、どちらが先に走っても docs の failed の契約 (`transport.closed` の reject のエラー) が保たれるためである。既存の `createPublicationStreamHandlers` の `onReadError` (受信した具体的なエラーで settle させる) と、0933 の docs (読み取りエラーが先に届いた場合はその読み取りエラーで settle する) とも揃う。正常終了でこの分岐に入るのは受信中の個別のストリームを読む `incomingPublishReadFirstBidiMessage` の経路だけであり、その場合は `"session closed by peer"` ではなく読み取りエラーで settle する。この扱いを docs に追記する
- 後から `transport.closed` が settle しても、2 回目の `sessionRejectPendingRequests` は reject を呼ばない (pending 系と送信待ちの Map は clear 済みで、publication と購読は `reject` を `undefined` にしている)。`markClosed()` は冪等なので 2 回呼んでも害は無い
- `sessionClose` は呼ばない。理由が `"session closed"` (自分からの close) になり、誤判定のときに健全な transport を閉じてしまうためである
- `requestsSendRequest` と 0933 の `namespacesSendSubscription` の手順 5 のコードは残し、理由のコメントを次のとおり直す。本 issue の後は状態だけを閉じる本番の経路が無くなり、手順 5 の時点で pending は reject 済みになるため、reject 自体は本番では no-op の防御になる
  - `requestsSendRequest` の手順 5: `requestsAbandonRequest` による登録の解除 (SUBSCRIBE の fill の関連付けと Track 単位の追跡の解放) とストリームの解放のために残す。ピア起点の終了はこれらを clear しない。closed の 0934 のテスト「ピア起点の close 後に write が完了したら登録を残さずに "session closed" でストリームを解放する」が固定している (0934 の状態を直接代入するテストは手順 2 のものである)
  - `namespacesSendSubscription` の手順 5: 状態の確認は、購読の state を `namespaceSubscriptions` / `tracksSubscriptions` に登録せず、受信ループも開始せずに、ストリームを `"session closed"` で解放するために残す (`close()` / ピア起点の終了 / 受信ループが検出した終了の後に write が完了した場合に要る)。0933 のテスト「close 後に write が完了したら登録せずに "session closed" でストリームを解放し予約を残す」と「write の待ちの間にピア起点で close すると "session closed by peer" で reject する」が固定している。`namespacesAbandonSubscription` の呼び出しは、送信待ちの登録が削除済みのため reject だけが働き、本 issue の後は no-op の防御になる。0933 のテスト「write の待ちの間に状態だけが閉じても "session closed" で reject し登録を残さない」がこれを確かめる

### 対象外

- `isSessionClosedError` の文字列の判定が、ローカル起源のエラー (`"session closed"` を含むメッセージ) に当たって Session を閉じたと誤判定する場合。transport が開いたまま状態だけが `"closed"` になり、`close()` も早期 return で効かない。誤判定の扱いは `namespaceLoops.ts` / `incomingPublish.ts` / `dataStreamIncoming.ts` の判定にも関わるため、別に扱う (未起票)。本 issue の変更後は、この場合も保留中の待ちは受け取ったエラーで reject され、request 系のオブジェクトは閉じた状態になる

## 完了条件

- 受信ループの読み取りエラーで `sessionNotifyErrorIfActive` が `isSessionClosedError` の分岐に入ったとき、`sessionRejectPendingRequests` の対象すべて (publishNamespace / publish / subscribe / fetch / trackStatus / REQUEST_UPDATE と、0933 の後の subscribeNamespace / subscribeTracks) の保留中の待ちが、受け取った読み取りエラーで 1 回だけ reject され、`callbacks.error` / `callbacks.close` は呼ばれないこと。送信の await が完了しない待ちと、応答の読み取りが終わらない待ちの両方を含む
- その後に `transport.closed` が resolve または reject しても、理由が変わらず、二重に reject されないこと (`closed` を settle できるテスト用 transport で確かめる)
- `callbacks.error` の分岐では、Session の状態も保留中の待ちも変わらないこと (既存の扱いのまま)
- 上記を固定する単体テストがあること (Node のテスト環境の文字列の判定で `isSessionClosedError` の分岐に入れる。制御ループでは `source` が `"session"` のエラーは除外されるため、データストリームか受信の双方向ストリームのループで入れる)
- `docs/LOW_LEVEL_API.md` の「通常の request stream」の「Session の終了時は、…」の段落と、0933 で追加される「Namespace 系の扱い」の「`subscribeNamespace()` / `subscribeTracks()` の送信」の「Session 終了時の契約」に、「ピア起点の終了でも、受信中のストリームの読み取りが先に終了を検出した場合は、その読み取りエラーで settle する」旨を追記すること。0933 の「Session 終了時の契約」には購読ストリーム自身の読み取りエラーについての文が既にあるため、そこに「送信待ちの間を含め、他の受信ループが先に検出した場合も」を足す形で統合し、重複させない。publishNamespace の項目は終了の理由を列挙していないため変えない
- 次のコメントと JSDoc の終了の経路を、新しい挙動 (受信ループが検出する経路を含む) に合わせること: `requestsSendRequest` / `namespacesSendSubscription` (0933) の手順 5 のコメントと JSDoc、`dataStreamFinishFetchStream` の JSDoc、`lifecycle.ts` の `sessionMarkRequestObjectsClosed` / `sessionRejectPendingRequests` / `sessionNotifyErrorIfActive`、`session.ts` の `SessionImpl.notifyErrorIfActive` の JSDoc (`SessionImpl` の private ラッパー `markRequestObjectsClosed` / `rejectPendingRequests` は削除するため JSDoc の更新は要らない)、`incomingPublishRunStreamSubLoop` の catch の、終了の順序への防御を述べるコメント (`transport.closed` に加え、他の受信ループの `sessionNotifyErrorIfActive` が先に後始末する順序でも catch の時点で state が closed になる)、`src/session.test.ts` の状態を直接代入するテスト (0934 の手順 2、0933 の手順 2 / 4-3 / 5) の JSDoc (本番に状態だけを閉じる経路が無くなったため防御の固定であることと、先に reject / clear する経路に受信ループの検出を加える。テスト自体は残す)
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/lifecycle.ts` の `sessionNotifyErrorIfActive` / `sessionClose` / `sessionMarkRequestObjectsClosed` / `sessionRejectPendingRequests` / `sessionStartControlMessageLoop`
- `src/session.ts` の `SessionImpl.notifyErrorIfActive` / `markRequestObjectsClosed` / `rejectPendingRequests` とコンストラクタの `transport.closed` の処理、`tsconfig.json` の `noUnusedLocals`、`issues/closed/0589-remove-unused-track-accessors.md`
- `src/session/dataStreamIncoming.ts` の `dataStreamStartIncomingStreamLoop` / `dataStreamStartDatagramLoop` / `dataStreamFinishFetchStream`
- `src/session/incomingPublish.ts` の `incomingPublishStartBidiStreamLoop` / `incomingPublishReadFirstBidiMessage`
- `src/session/bidi.ts` の `bidiDispatchResponse` / `defaultBidiHandleError` / `bidiReadRequestStreamMessages` / `handleRequestStreamReadError`
- `src/session/namespaceLoops.ts` の `createPublicationStreamHandlers` (`onReadError`)
- `src/session/requests.ts` の `requestsSendRequest` / `requestsAbandonRequest`、`src/session/incomingPublish.ts` の `incomingPublishRunStreamSubLoop`、`src/session/namespaceLoops.ts` の `namespaceHandleSubscriptionReadError`、`src/session/namespaces.ts` の `namespacesSendPublishNamespace` / `namespacesSendSubscription` (0933)
- `src/session/errors.ts` の `isSessionClosedError`
- `src/testSupport/bidi.ts` の `createTestWebTransport`、`src/session.test.ts` の `createHeldBidiStreamTransport` / `createPendingNamespaceTransport`
- `docs/LOW_LEVEL_API.md` の「通常の request stream」/「Namespace 系の扱い」
- W3C WebTransport の "cleanup a WebTransport" と、接続エラーによる終了 (termination caused by connection error) の手順
- open の `issues/0933-bug-subscribe-namespace-pending-settle.md` (先に対応する。購読系の待ちを `sessionRejectPendingRequests` に加える)
- `issues/closed/0934-bug-requests-pending-settle.md` (この経路を本 issue に委ねた残した課題)、`issues/closed/0890-bug-publish-namespace-pending-settle.md` (publishNamespace の送信待ちの reject)、`issues/closed/0543-bug-control-stream-reset-close.md` (アプリコールバックの throw では Session を閉じない方針)
- draft-ietf-moq-transport-23 §6.6 (Termination)。pending の settle を定める規定ではなく、ライブラリの方針である
