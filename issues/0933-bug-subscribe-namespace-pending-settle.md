# subscribeNamespace / subscribeTracks の確立前に Session が終了すると待ちが終了の理由で settle しない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subscribe-namespace-pending-settle
- Polished: 2026-11-10

## 目的

`Session.subscribeNamespace()` と `Session.subscribeTracks()` は、REQUEST_OK を受けて確立するまでの間に Session が終了したとき、呼び出し元の Promise を終了の理由で settle させる仕組みを持たない。確立前の窓は 2 つあり、どちらにも穴がある。

送信待ち (ストリームの作成と要求の書き込みの await) の窓。両関数は `async` 関数であり、create / write を await してから `new Promise` を作る。そのため送信待ちの間はまだ Promise が無く、`sessionRejectPendingRequests` が reject できない。症状は transport の振る舞いで 3 通りに分かれる。

- create / write の await が解決しない場合: 呼び出し元の Promise は settle しない
- create / write の await が終了によって reject する場合: 呼び出し元は終了の理由ではなく transport のエラーで settle する。W3C WebTransport は、`createBidirectionalStream()` を状態が `"closed"` / `"failed"` になった時点で `InvalidStateError` で reject し、cleanup で保留中の write を reject すると定めており、実ブラウザではこちらになる
- close の後に create / write の await が解決する場合: 状態を確認しないため、閉じた Session へ write し、`sessionClose` が片付けた後の `namespaceSubscriptions` / `tracksSubscriptions` に登録して受信ループを始める

登録後から REQUEST_OK までの窓。購読の state (`NamespaceSubscriptionState` / `TracksSubscriptionState`) は publication と違って `reject` を持たず、`sessionRejectPendingRequests` の走査対象でもない。

- 自分からの `close()`: 受信ループの読み取りが done になり、`"stream closed before receiving response"` で reject する。終了の理由 (`"session closed"`) にならない (publishNamespace は同じ窓で `"session closed"` になる)
- ピア起点の close: `transport.closed` の処理が `markRequestObjectsClosed` で先に state を `"closed"` にするため、読み取りが失敗しても `namespaceHandleSubscriptionReadError` は reject しない (`state === "active"` のときだけ reject する)。ストリームを error にしない transport では settle せず、実ブラウザでは読み取りエラーと `transport.closed` の処理のどちらが先かに依存する

publishNamespace では、送信待ちの窓を 0890 が、登録後の窓を `NamespacePublicationState.reject` が塞いでいる。request 系 4 API は closed の 0934 で送信待ちの窓を塞いだ。購読系の 2 API も、どちらの窓でも未確立の待ちを 1 回だけ settle させ、未処理の rejection を残さないようにする。Session の終了が先に処理された場合は終了の理由 (`"session closed"` / `"session closed by peer"` / `transport.closed` の reject のエラー) で、登録後の窓で読み取りエラーが `transport.closed` の処理より先に届いた場合はその読み取りエラーで settle する (publishNamespace の `createPublicationStreamHandlers` の `onReadError` と同じ判断。読み取りエラーと `transport.closed` の処理の順序そのものは本 issue では変えない)。

## 現状

- `src/session/namespaces.ts` の `namespacesSubscribeNamespace` / `namespacesSubscribeTracks` は `async` 関数である。`src/session.ts` の `SessionImpl.subscribeNamespace` / `subscribeTracks` は、これらを `async` メソッドから return する
- 両関数の流れは次のとおりである
  1. 状態と GOAWAY の確認、Request ID の採番、`validateTrackNamespaceForSend`、`validateRangeFilterLimits` (subscribeTracks のみ)
  2. `await session.transport.createBidirectionalStream()`、`getReader()`、`new ControlStreamReader(...)`、`getWriter()` (いずれも try の外)
  3. try の中で、パラメータの構築、encode、`ControlStreamWriter.encode` によるフレーミング、debug コールバック、認可トークンの予約 (`requestsReserveAuthorizationToken`)、`await writer.write(framed)`
  4. 送信の失敗は、予約を取り消し、`namespacesCleanupSendFailure` を await してから throw する
  5. `new Promise` を作り、`namespaceSubscriptions` / `tracksSubscriptions` に登録して受信ループ (`namespacesStartNamespaceStreamLoop` / `namespacesStartTracksStreamLoop`) を開始する
- 認可トークンの正規化 (`requestsNormalizeAuthorizationToken`) は、subscribeNamespace ではストリームの作成より前、subscribeTracks では後にある
- create と write の後に Session の状態を確認しない
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests` は `pendingPublish` / `pendingSubscribe` / `pendingFetch` / `pendingRequestUpdate` / `pendingTrackStatus` / `namespacePublications` / `pendingNamespacePublication` を走査するが、購読系の 2 つの Map は対象外である。送信待ちの reject を保持する Map も無い
- `src/session/types.ts` で `reject` を持つのは `NamespacePublicationState` だけである。`src/session/namespaceLoops.ts` の `namespaceStartPublicationStreamLoop` は確立時に `resolveEstablished` で `publication.reject = undefined` にする。購読系のループ (`namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop`) には同じ仕組みが無い

## 設計方針

closed の 0934 (`src/session/requests.ts` の `requestsSendRequest`) と、publishNamespace (`namespacesSendPublishNamespace`) の形に揃える。publishNamespace 自身の debug の位置は open の 0935 の範囲なので、本 issue では publishNamespace を変更しない。

### 同期部と detached 部の分け方

- 同期関数にするのは `namespacesSubscribeNamespace` / `namespacesSubscribeTracks` である。`SessionImpl.subscribeNamespace` / `subscribeTracks` は `async` のまま残し、同期の throw を rejection に変換する契約を変えない
- Promise の作成より前 (同期部) に済ませるのは、状態と GOAWAY の確認、Request ID の採番、`validateTrackNamespaceForSend`、`validateRangeFilterLimits` (subscribeTracks)、`requestsNormalizeAuthorizationToken`、パラメータの構築、encode、`ControlStreamWriter.encode` によるフレーミングである。送信の入力 (購読の state を作るための値を含む) も Promise の作成より前に組み立てる
- debug コールバックは同期部に移さない。0934 と同じく、ストリームの作成と reader / writer の取得の後、予約の後、write の前に出す
- Promise の executor では、送信待ち専用の Map への reject の登録と、detached 送信の開始だけを行う。Map は API ごとに `pendingNamespaceSubscription` / `pendingTracksSubscription` の 2 つとし (`pendingNamespacePublication` と同じ形の `{ reject }`)、`SessionImpl` / `NamespacesSessionInternal` / `SessionLifecycleInternal` に追加する
- `sessionRejectPendingRequests` に、`pendingNamespacePublication` と同じ形 (各エントリの reject を呼んでから clear する) で `pendingNamespaceSubscription` / `pendingTracksSubscription` の走査を追加する
- detached 送信は購読系の 2 API で 1 つの関数を共有する。API ごとの差 (送信待ちの Map、登録先の Map と state の構築、受信ループの開始関数) は引数で渡す

### detached 部の手順

1. `createBidirectionalStream()` を await する
2. Session の状態を確認する
3. `getReader()` / `new ControlStreamReader(...)` / `getWriter()` を try の中で行う
4. 次を 1 つの try の中で順に行う
   1. 認可トークンを予約する
   2. debug コールバックを呼ぶ
   3. Session の状態を確認する (debug コールバックが同期的に Session を閉じた場合に、閉じた Session へ write しないため)
   4. write を await する
5. 送信待ちの Map から削除し、Session の状態を確認する。開いていれば、購読の state (`reject` を含む) を `namespaceSubscriptions` / `tracksSubscriptions` に登録して受信ループを開始する

送信待ちの Map は送信待ち専用の登録なので、手順 5 では状態の確認より前に無条件で削除する (`namespacesSendPublishNamespace` と同じ)。経路ごとの後始末は次のとおりとする。どの経路でも、同期の登録解除を reject より先に行い、ストリームの解放 (await を伴う) は最後に行う。cancel / abort の理由は、失敗の経路では `"namespace request send failed"`、閉じていた経路では `"session closed"` とする (`namespacesSendPublishNamespace` と同じ値)。

| 経路                   | 同期の登録解除                                                           | reject                                     | ストリーム                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 の失敗               | 送信待ちの Map から削除                                                  | 元のエラー                                 | 無し                                                                                                                                                                                              |
| 2 で閉じていた         | 送信待ちの Map から削除                                                  | `"session closed"` (reject 済みなら no-op) | `requestsReleaseUnlockedStream(stream, "session closed")`                                                                                                                                         |
| 3 の失敗               | 送信待ちの Map から削除                                                  | 元のエラー                                 | reader を取得済みなら reader を cancel して releaseLock、未取得なら `requestsReleaseUnlockedStream` (理由は `"namespace request send failed"`。`namespacesSendPublishNamespace` の取得失敗と同じ) |
| 4-1 / 4-2 / 4-4 の失敗 | 予約していれば取り消し、送信待ちの Map から削除                          | 元のエラー                                 | `namespacesCleanupSendFailure(streamReader, writer)`                                                                                                                                              |
| 4-3 で閉じていた       | 予約の取り消し (まだ送っていない)、送信待ちの Map から削除               | `"session closed"` (reject 済みなら no-op) | `namespacesCleanupSendFailure(streamReader, writer, "session closed")`                                                                                                                            |
| 5 で閉じていた         | (送信待ちの Map は削除済み) 登録しない。予約は送信済みなので取り消さない | `"session closed"` (reject 済みなら no-op) | `namespacesCleanupSendFailure(streamReader, writer, "session closed")`                                                                                                                            |
| 5 で開いていた         | 無し                                                                     | 無し                                       | 購読の state を登録して受信ループを開始する                                                                                                                                                       |

4-3 で閉じていた場合は throw で catch に流さず、try を抜けてから後始末する (0934 と同じく、catch と後始末が二重にならない構造にする)。

### 登録後から REQUEST_OK までの窓

- `NamespaceSubscriptionState` / `TracksSubscriptionState` に `reject?: ((error: Error) => void) | undefined` を追加し、手順 5 の登録時に設定する
- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` に、`namespaceStartPublicationStreamLoop` と同じく確立時に `reject` を `undefined` に戻す処理 (`resolveEstablished` に相当するもの) を設ける
- `sessionRejectPendingRequests` に、`namespacePublications` と同じ形 (`reject` を `undefined` にしてから呼ぶ) で `namespaceSubscriptions` / `tracksSubscriptions` の走査を追加する。エントリの削除は受信ループに任せる (`namespacePublications` と同じ)
- state は `sessionMarkRequestObjectsClosed` が先に `"closed"` にするため、確立前かどうかの判定に state を使わない (`reject` の有無で判定する)
- `namespaceHandleSubscriptionReadError` は変えない。読み取りエラーが `transport.closed` の処理より先に届いた場合は、state がまだ `"active"` なので読み取りエラーで reject し、その後の `sessionRejectPendingRequests` の reject は no-op になる (`createPublicationStreamHandlers` の `onReadError` のコメント「未確立の publishNamespace() の待ちを sessionRejectPendingRequests の汎用エラーではなく、受信した具体的なエラーで settle させるため」と同じ判断)

### 挙動の変化

- パラメータの構築・encode・フレーミングの失敗では、ストリームを開かずに同期の throw (呼び出し元には rejection) になる
- 予約の失敗では debug コールバックを呼ばない (現状は debug の後に予約する)
- 制御メッセージの送信統計 (`statsControlMessagesSent`) は、現状どおり購読系では加算しない (request 系との違いは本 issue の範囲外)

### 対象外

- create / write の await が解決しないまま Session が終了した場合の、送信中のストリームの解放。open の 0939 (publishNamespace の同じ窓) と同じ論点であり、request 系 (0934) と購読系にも同型の follow-up が要る。本 issue では、await が後から解決した時点でストリームを解放するところまでを扱う
- `sessionNotifyErrorIfActive` で状態だけが閉じ、かつ await が解決しない場合 (open の 0936 の範囲)
- 送信待ちの間に GOAWAY を受けた場合の扱い (publishNamespace については open の 0938 で判断する。購読系も同じ論点であり、0938 の判断に合わせる)
- `sessionHasOpenSubscriptionsOrFetches` に送信待ちの Map を加えること (0890 の解決方法と同じ判断で加えない)
- publishNamespace の変更

## 完了条件

- テストは、確立後の `reject` の確認を除いて `src/session.test.ts` に置き、`createHeldBidiStreamTransport` と、登録後の窓には `createPendingNamespaceTransport` を使う。2 API (`subscribeNamespace` / `subscribeTracks`) それぞれについて次を固定する (2 API で同じテスト本体を使い回してよい)
  - ストリームの作成が失敗するとき (`failCreate: true`)、Session は開いたまま、元のエラーで reject し、送信待ちの Map が空になる (経路 1)
  - write の await が解決しないまま自分から close したとき、`"session closed"` で reject する
  - write の await が解決しないままピア起点で close したとき、`"session closed by peer"` で reject する
  - ストリーム作成の await が解決しないまま close したとき (`holdCreate: true`)、reject し、`releaseCreate` の後にストリームがロックを取らずに `"session closed"` で cancel / abort され (`cancelled` / `aborted` が `["session closed"]`)、送信待ちの Map が空になる (経路 2)
  - ストリーム作成の await が解決しない間に内部状態の直接代入 (`(session as unknown as { sessionState: string }).sessionState = "closed"`) で状態だけを閉じ、`releaseCreate` で作成を完了させたとき、`"session closed"` で reject し、送信待ちの Map が空になり、`cancelled` / `aborted` が `["session closed"]` になる (経路 2。`close()` / `closeFromPeer` では送信待ちの Map が先に reject / clear されるため確かめられない)
  - writable を事前にロックして `getWriter()` を失敗させたとき、元のエラーで reject し、解放の完了を待ってから、`cancelled` が `["namespace request send failed"]`、`readable.locked` が `false`、送信待ちの Map が空であることを確かめる (経路 3 の reader 取得済みの側。「publishNamespace: writer 取得失敗時に reader を解放して reject する」と同じ形)
  - readable を事前にロックして `getReader()` を失敗させたとき、元のエラーで reject し、解放の完了を待ってから、`aborted` が `["namespace request send failed"]`、送信待ちの Map が空であることを確かめる (経路 3 の reader 未取得の側。「publishNamespace: getReader 失敗時に raw ストリームを解放する」と同じ形)
  - 認可トークンの予約が失敗するとき (`peerMaxAuthTokenCacheSize = 0n` で REGISTER トークンを付ける)、元のエラーで reject し、debug コールバックが呼ばれず、write が呼ばれず、`"namespace request send failed"` で解放される (経路 4-1)
  - debug コールバックが throw したとき、元のエラーで reject し、解放の完了を待ってから、`cancelled` / `aborted` が `["namespace request send failed"]`、ロックが残らず、送信待ちの Map が空であることを確かめる (経路 4-2)
  - debug コールバックが同期的に `session.close()` したとき (REGISTER トークン付き)、`"session closed"` で reject し、write が呼ばれず、`peerRegisteredAuthTokenSize` が `0n` に戻り、`cancelled` / `aborted` が `["session closed"]` になる (経路 4-3)
  - REGISTER トークン付きで write を失敗させたとき (`failWrite: true`)、元のエラーで reject し、送信待ちの Map が空になり、`peerRegisteredAuthTokenSize` が `0n` に戻る (経路 4-4)
  - close の後に write が完了したとき、`namespaceSubscriptions` / `tracksSubscriptions` に登録されず、`cancelled` / `aborted` がちょうど `["session closed"]` になり、ロックが残らない (経路 5。現状のコードは登録して受信ループを始めるため、新旧の実装を区別できる)
  - close の後に write が失敗したとき (REGISTER トークン付き)、未処理の rejection が発生せず (`withUnhandledRejectionWatch` で監視する)、Promise が `"session closed"` で reject し、`cancelled` が `["namespace request send failed"]`、`peerRegisteredAuthTokenSize` が `0n` になる (close が送信待ちの Map を先に reject し、write の失敗は 4-4 の catch が後始末する。`aborted` は errored になった writable で sink が呼ばれないため期待値に入れない)
  - 登録後で REQUEST_OK を受ける前に自分から close したとき `"session closed"` で、ピア起点で close したとき `"session closed by peer"` で reject する (「publishNamespace: Session の close で未確立の待ちが reject する」「publishNamespace: ピア起点の close で未確立の待ちが reject する」と同じ形。登録を待ってから終了させる)
- 確立後の `reject` は `src/session/namespaceLoops.test.ts` で確かめる。`createNamespaceLoopTestContext` / `startLoop` / `requestOkMessage` を使い、namespace / tracks のそれぞれで、target に `reject` を置いた状態でループを開始し、REQUEST_OK を受ける前は関数で、受けた後は `undefined` になることを固定する (`src/session.test.ts` のテスト用 transport は REQUEST_OK を流せないため)
- 既存のテストを次のように扱う
  - 「subscribeNamespace: write 失敗時にストリームリソースを掃除して Map に登録しない」「subscribeTracks: write 失敗時にストリームリソースを掃除して Map に登録しない」「subscribeNamespace: 送信前の throw でもストリームリソースを掃除する」「subscribeTracks: 送信前の throw でもストリームリソースを掃除する」は、解放が reject の後になるため、解放の完了を待ってから検証する形に直す。「後始末を完了してから throw するため、待ちは不要」のコメントと、「subscribeTracks: 送信前の throw でもストリームリソースを掃除する」の「encode / build 失敗の代理」のコメント (encode / build の失敗はストリームを開かない同期の throw になるため成り立たなくなる) も直す
- `src/session.ts` の `Session` インターフェースの `subscribeNamespace` / `subscribeTracks` の JSDoc に、「Session の終了時は、送信待ち (ストリーム作成 / write の await) の間と REQUEST_OK を受ける前を含めて、未確立の Promise を reject する (§6.6。根拠の仕様はドラフトであり将来変更される可能性がある)」の趣旨の契約を新設する。`SessionImpl.subscribeNamespace` / `subscribeTracks` には、`async` が同期の throw を rejection に変換するために必要である旨のコメントを書く (0934 で他の API に付けたものと同じ)
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」の `subscribeNamespace()` / `subscribeTracks()` の項目に、同じ契約を書く
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaces.ts` の `namespacesSubscribeNamespace` / `namespacesSubscribeTracks` / `namespacesCleanupSendFailure` / `namespacesPublishNamespace` / `namespacesSendPublishNamespace` / `namespacesStartNamespaceStreamLoop` / `namespacesStartTracksStreamLoop`
- `src/session/namespaceLoops.ts` の `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` / `namespaceHandleSubscriptionReadError`
- `src/session/requests.ts` の `requestsSendRequest` / `requestsReadSessionState` / `requestsReleaseUnlockedStream` / `requestsReserveAuthorizationToken` / `requestsReleaseAuthorizationToken` (0934 の形)
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests` / `sessionClose` / `sessionMarkRequestObjectsClosed`
- `src/session/types.ts` の `NamespaceSubscriptionState` / `TracksSubscriptionState` / `NamespacePublicationState`
- `src/session.ts` の `Session` インターフェース / `SessionImpl` (コンストラクタの `transport.closed` の処理)
- `src/session.test.ts` の `createHeldBidiStreamTransport` / `createPendingNamespaceTransport` と、publishNamespace / request 系の送信待ちのテスト群
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」
- closed の `0890-bug-publish-namespace-pending-settle.md` (publishNamespace の送信待ち) / `0934-bug-requests-pending-settle.md` (request 系の送信待ち)
- open の `0935-bug-debug-send-before-stream.md` / `0936-bug-session-notify-error-pending.md` / `0938-update-publish-namespace-goaway-during-send.md` / `0939-bug-publish-namespace-stream-release-on-stuck-write.md`
- draft-ietf-moq-transport-23 §6.6 (Termination) / §9.14 (SUBSCRIBE_NAMESPACE) / §9.17 (SUBSCRIBE_TRACKS)
- W3C WebTransport の `createBidirectionalStream()` と cleanup

## 現状の補足

実装・解決方法・closed のコミットは `origin/feature/fix-subscribe-namespace-pending-settle` にあり、develop には未マージである (`d2e79929` / `2656deef` / `2dc31b53`)。develop のコードでは本 issue の完了条件は未達のままなので、マージするか破棄するかを決める必要がある。
