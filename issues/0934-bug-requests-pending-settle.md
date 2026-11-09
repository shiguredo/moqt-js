# requests 系 4 API の送信待ちの間に Session が終了すると待ちが settle しない

- Created: 2026-11-03
- Completed: 2026-11-10
- Branch: feature/fix-requests-pending-settle
- Polished: 2026-11-10

## 目的

`Session.publish()` / `subscribe()` / `fetch()` / `trackStatus()` は、保留中の Promise を送信より前に `pendingPublish` などへ登録する。しかし呼び出し元が待つのは、`async` 関数が返す外側の Promise である。`async` 関数は送信の await (ストリーム作成と write) を終えるまで return しない。そのため送信待ちの間に Session が終了すると、呼び出し元の待ちがどう決着するかは送信の await の結果次第になる。

- create / write の await が解決しない場合: `sessionRejectPendingRequests` が reject するのは「まだ return されていない内側の Promise」だけである。呼び出し元の待ちは settle せず、reject された内側の Promise は誰も受け取らないため未処理の rejection になる
- create / write の await が終了によって reject する場合: 呼び出し元は、終了の理由 (`"session closed"` / `"session closed by peer"`) ではなく transport のエラーで settle する。さらに、`sessionRejectPendingRequests` が reject した内側の Promise を誰も受け取らず、未処理の rejection になる。W3C WebTransport は、`createBidirectionalStream()` を状態が `"closed"` / `"failed"` になった時点で `InvalidStateError` で reject し、送信ストリームの cleanup で保留中の write を reject すると定めており、実ブラウザではこちらになる

publishNamespace では、送信を detached にして外側の Promise を先に返す形にした (0890)。requests 系の 4 API には同じ窓が残っている。どちらの場合も Session の終了の理由で 1 回だけ settle させ、未処理の rejection を残さないようにする。

## 現状

- `src/session/requests.ts` の `requestsPublish` / `requestsSubscribe` / `requestsFetch` / `requestsTrackStatus` は `async` 関数である。`src/session.ts` の `SessionImpl.publish` / `subscribe` / `fetch` / `trackStatus` は、これらを `async` メソッドから return する。`requestsX` を呼ぶのは `SessionImpl` だけである
- 4 関数とも、`new Promise` で `pendingPublish` / `pendingSubscribe` / `pendingFetch` / `pendingTrackStatus` へ `reject` を登録してから、`try` の中で認可トークンを予約 (`requestsReserveAuthorizationToken`) し、`await requestsSendRequestOnBidiStream(...)` する。その後で `return promise` する
  - `requestsSubscribe` の `encodeSubscribePayload` と fill の関連付け (`fillFetchTargets.set`)、`requestsTrackStatus` の認可トークンの正規化・`buildTrackStatusParameters`・`encodeTrackStatusPayload` は、Promise の作成より後にある
- `requestsSendRequestOnBidiStream` は `src/session/bidi.ts` の `bidiSendRequestOnBidiStream` を呼ぶだけの薄いラッパーである。送信の本体 `bidiSendRequestOnBidiStream` は、次を 1 本の async 処理として順に行う
  1. `controlWriter` の存在確認 (`"Control writer not initialized"`)
  2. `controlWriter.encode` によるフレーミング (ピアの MAX_CONTROL_MESSAGE_SIZE を超えると throw)
  3. `await session.transport.createBidirectionalStream()`
  4. `stream.writable.getWriter()` と `ControlStreamReader` の生成
  5. `session.statsControlMessagesSent++` の後に `session.emitDebug("send", ...)` (ストリームの作成後、write の前)
  6. `await writer.write(message)`。失敗時はストリームの cancel / abort を await してから throw する
  7. 成功時に `session.requestStreams.set(requestId, streamInfo)`
- create と write の後に Session の状態を確認しない。このため、close 後でも write し、`sessionClose` が `requestStreams` を片付けた後に `requestStreams.set` する
- 送信失敗の catch は、予約を取り消し、pending のエントリを削除して throw する。subscribe は `bidi.deleteFillFetchTarget` を、subscribe / fetch は `bidi.clearPriorGapTrackingIfUnused` を呼ぶ。後者は `pendingSubscribe.get(requestId)` / `pendingFetch.get(requestId)` から `impl` を引くため、Session の終了で pending が clear された後は呼ばれない
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests` は、上の 4 つの Map を走査して reject し、clear する
- ピア起点の close (`SessionImpl` のコンストラクタの `transport.closed.then`) は、`markRequestObjectsClosed` と `rejectPendingRequests(new Error("session closed by peer"))` を行う。`requestStreams`、`fillFetchTargets`、`priorGapTrackingByTrack` は消さない (これらを clear するのは `sessionClose` だけである)

## 設計方針

publishNamespace (`src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesSendPublishNamespace`) と同じ形にする。

### 同期部と detached 部の分け方

- 同期関数にするのは `requestsPublish` / `requestsSubscribe` / `requestsFetch` / `requestsTrackStatus` である。これらは Promise を送信より先に return し、送信を detached な async 処理に切り出す。`SessionImpl` の公開メソッドは `async` のまま残し、同期の throw (`"Session is closed"`、検証エラーなど) を rejection に変換する現在の契約を変えない
- Promise の作成より前 (同期部) に済ませるのは、同期検証、認可トークンの正規化、パラメータ構築、payload の encode (`encodeSubscribePayload` / `encodeTrackStatusPayload` を含む)、`controlWriter` の存在確認とフレーミングである
- debug イベントの出力 (`emitDebug`) は同期部に移さない。現状どおり、ストリームの作成と writer の取得の後、write の前に出す (実際に transport に渡っていないメッセージを「送信した」と見せないため。open の 0935 は publishNamespace の debug をこの位置に揃える issue であり、request 系の位置を変えると 0935 の前提が崩れる)
- このため `bidiSendRequestOnBidiStream` を 2 つに分ける
  - 同期部: `controlWriter` の存在確認とフレーミングを行い、フレーミング済みのメッセージを返す関数 (`src/session/bidi.ts` に置く)
  - 送信の async 部: 4 API で共通の detached 送信関数を `src/session/requests.ts` に 1 つ置く。API ごとに異なる後始末 (pending の Map、fill の関連付け、`clearPriorGapTrackingIfUnused` の要否) と受信ループの開始は引数で渡す。`requestsSendRequestOnBidiStream` は不要になるので削除する
- Promise の executor で、pending への登録と subscribe の fill の関連付け (`fillFetchTargets.set`) を同時に行い、detached 送信を開始する

### detached 部の手順

送信の async 部は、次の順で進める。

1. `createBidirectionalStream()` を await する
2. Session の状態を確認する
3. `getWriter()` と `ControlStreamReader` の生成を行う
4. 次を 1 つの try の中で順に行う (予約を取り消す catch を 1 つにするため)
   1. 認可トークンを予約する
   2. `statsControlMessagesSent++` と `emitDebug("send", ...)` を行う (予約の失敗では send イベントも統計の加算も起きないようにするため、予約の後に置く)
   3. Session の状態を確認する (debug コールバックが同期的に Session を閉じる場合に、閉じた Session へ write しないため)
   4. write を await する

   4 の try の catch は 4-1 / 4-2 / 4-4 の throw を受ける。4-3 で閉じていた場合は throw せず、その場で後始末して return する

5. Session の状態を確認する

予約をストリームの作成より後に置くため、予約のローカルな失敗 (`SessionImpl.reserveAuthorizationTokenForSend` の再 REGISTER / 上限超過) でも、双方向ストリームを開いてから解放するように挙動が変わる。現状はストリームを開かない。publishNamespace と同じ挙動であり、予約を取り消す経路を、予約後の try の catch (4-1 / 4-2 / 4-4) と 4-3 の閉じていた経路に限るためにこれを受け入れる (予約をストリームの作成より前に置くと、1 / 2 / 3 の経路でも取り消しが要る)。4-3 は throw で catch に流さず、try の中でその場で予約を取り消して return する (reject と cancel / abort の理由が catch 側と異なるため)。

経路ごとの後始末は次のとおりとする。どの経路でも、同期の登録解除を reject より先に行い、ストリームの解放 (await を伴う) は最後に行う。後始末の await 中に Session が終了しても、汎用の終了理由で先に reject されないようにするためである。`impl` は pending の Map から引き直さず、detached 処理が保持している参照を使う。cancel / abort の理由は、失敗の経路では `"request send failed"` (現状の `bidiSendRequestOnBidiStream` と同じ値)、閉じていた経路では `"session closed"` に揃える。

| 経路                                                   | 同期の登録解除                                                                                                                          | reject                                     | ストリーム                                                                                                                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 の失敗                                               | pending の削除、fill の関連付けの削除、`clearPriorGapTrackingIfUnused`                                                                  | 元のエラー                                 | 無し                                                                                                                                                                            |
| 2 で閉じていた                                         | pending の削除、fill の関連付けの削除、`clearPriorGapTrackingIfUnused`                                                                  | `"session closed"` (reject 済みなら no-op) | ロックを取らずに `"session closed"` で readable を cancel / writable を abort                                                                                                   |
| 3 の失敗 (getWriter の throw)                          | pending の削除、fill の関連付けの削除、`clearPriorGapTrackingIfUnused`                                                                  | 元のエラー                                 | ロックを取らずに `"request send failed"` で readable を cancel / writable を abort (writable が他でロックされていれば abort は失敗し、無視する)                                 |
| 4-1 / 4-2 / 4-4 の失敗 (予約 / debug / write の throw) | 予約していれば取り消し、pending の削除、fill の関連付けの削除、`clearPriorGapTrackingIfUnused`                                          | 元のエラー                                 | `"request send failed"` で readable を cancel、writer を abort して releaseLock                                                                                                 |
| 4-3 で閉じていた                                       | 予約の取り消し (まだ送っていない)、pending の削除、fill の関連付けの削除、`clearPriorGapTrackingIfUnused`                               | `"session closed"` (reject 済みなら no-op) | `"session closed"` で readable を cancel、writer を abort して releaseLock                                                                                                      |
| 5 で閉じていた                                         | pending の削除、`requestStreams` に登録しない、fill の関連付けの削除、`clearPriorGapTrackingIfUnused`。予約は送信済みなので取り消さない | `"session closed"` (reject 済みなら no-op) | `"session closed"` で readable を cancel、writer を abort して releaseLock                                                                                                      |
| 5 で開いていた                                         | 無し                                                                                                                                    | 無し                                       | 現状どおり `requestStreams` に登録し、受信ループ (`bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse`) を開始する |

fill の関連付けの削除は subscribe だけ、`clearPriorGapTrackingIfUnused` は subscribe / fetch だけが対象である。

「閉じていた」経路 (2 / 4-3 / 5) でも pending を明示的に削除し、`"session closed"` で reject するのは、`sessionNotifyErrorIfActive` のように状態だけを `"closed"` にして pending を reject も clear もしない経路があるためである (この経路で Promise を settle させるのは detached 部の reject だけになる。`sessionNotifyErrorIfActive` が pending を reject するようにする修正は open の 0936 の範囲)。`clearPriorGapTrackingIfUnused` は応答待ちの pending を「利用中」と数えるため、pending の削除はその呼び出しより先に行う。なお、先例の `namespacesSendPublishNamespace` は write の完了後、状態を確認する前に `pendingNamespacePublication` を無条件に削除するが、request 系ではそうしない。先例の `pendingNamespacePublication` は送信待ち専用の登録であり、受信側の状態は `namespacePublications` が持つ。これに対して request 系の pending は応答待ちの登録そのものであり、5 で開いていた経路では残す必要がある。

### 対象外

- create / write の await が解決しないまま Session が終了した場合の、送信中のストリームの解放。0939 (publishNamespace の同じ窓) と同じ論点であり、request 系にも同型の follow-up が要る。本 issue では、await が後から解決した時点でストリームを解放するところまでを扱う

## 完了条件

- テストは `src/session.test.ts` に置き、`createHeldNamespaceTransport` (holdCreate / failWrite / releaseWrite / releaseCreate / writeStarted / closeFromPeer / cancelled / aborted) を流用する。request 系の送信には `controlWriter` の設定が要る (`createWriteFailureSession` と同じく `controlWriter = new ControlStreamWriter()` を設定した `SessionImpl` を使う)。4 API (`publish` / `subscribe` / `fetch` / `trackStatus`) それぞれについて、次を固定する
  - write の await が解決しないまま自分から close したとき、Promise が `"session closed"` で reject する
  - write の await が解決しないままピア起点で close したとき、Promise が `"session closed by peer"` で reject する
  - ストリーム作成の await が解決しないまま close したとき (`holdCreate: true`)、Promise が reject する。その後 `releaseCreate` で作成を完了させると、ストリームがロックを取らずに `"session closed"` で cancel / abort され (`cancelled` / `aborted` が `["session closed"]`)、pending のエントリが残らない (経路 2)
  - ストリーム作成の await が解決しない間に、内部状態の直接代入 (`(session as unknown as { sessionState: string }).sessionState = "closed"`。`src/session.test.ts` の制御ループ系のテストに同じ書き方の先例がある) で状態だけを `"closed"` にし、`releaseCreate` で作成を完了させたとき、Promise が `"session closed"` で reject し、pending のエントリが残らず、`cancelled` / `aborted` が `["session closed"]` になる (経路 2。状態だけが閉じる経路で detached 部の reject と pending の削除が働くことを確かめる。`close()` / `closeFromPeer` では pending が先に reject / clear されるため確かめられない。`notifyErrorIfActive` を使うと、0936 で pending を reject するようになった後はこのテストが何も確かめなくなるため使わない)
  - writable を事前にロックして `getWriter()` を失敗させたとき、Promise が元のエラーで reject し、解放の完了を待ってから、`cancelled` が `["request send failed"]`、`aborted` が `[]` (テストが writable のロックを持つため abort は失敗する)、`readable.locked` が `false`、pending のエントリが残らないことを確かめる (経路 3。先例の「publishNamespace: writer 取得失敗時に reader を解放して reject する」と同じ形)
  - debug コールバックが throw したとき、Promise が元のエラーで reject し、解放の完了を待ってから、pending のエントリが残らず、`cancelled` / `aborted` が `["request send failed"]`、readable / writable のロックが残らないことを確かめる (経路 4-2。本設計では reject が解放より先に来るため、先例の「subscribeNamespace: 送信前の throw でもストリームリソースを掃除する」と違い、解放を待つ)
  - debug コールバックが同期的に `session.close()` したとき、Promise が `"session closed"` で reject し、transport の write が呼ばれず (`writeStarted` が解決しない)、`cancelled` / `aborted` が `["session closed"]` になる (経路 4-3。先例の「publishNamespace: debug コールバックの同期 close でも reject する」に対応する)
  - REGISTER の認可トークン付きの要求で write を失敗させたとき (`failWrite: true`)、元のエラーで reject し、pending のエントリが残らず、`peerRegisteredAuthTokenSize` が `0n` に戻る (経路 4-4。先例の「publishNamespace: write 失敗時に REGISTER の予約を取り消す」と同じ形)
  - close の後に write が完了したとき、`requestStreams` にエントリが残らず、`cancelled` / `aborted` がちょうど `["session closed"]` になり、`writable.locked` が `false` になる (経路 5。現状のコードは受信ループの pending 未登録の分岐で `"request cancelled"` を理由に解放し releaseLock しないため、理由とロックの検証で新旧の実装を区別できる)
  - close の後に write が失敗したとき、未処理の rejection が発生しない (`"publish: 送信失敗後に close() しても unhandled rejection が発生しない"` と同じく `unhandledRejection` を監視する)
- 4 API で同じテスト本体を使い回してよい (API ごとにテストを生成する形でよい)
- subscribe は、経路 4-4 と経路 5 のテストで `fill` を指定し、`fillFetchTargets` に関連付けが残らないことも固定する。経路 5 の fill の検証は `closeFromPeer` でピア起点に close して行う (自分からの close では `sessionClose` が `fillFetchTargets` を clear するため、detached 部の削除を確かめられない)。既存の「subscribe: 送信失敗時は fill 関連付けと保留中の SUBSCRIBE が残らない」は、同期部の `controlWriter` の確認で fill の登録より前に失敗する経路になり、fill の削除経路を通らなくなるためである
- 既存のテストを次のように扱う
  - 「送信失敗時に throw し pending が残らない」系、「ピアの MAX_CONTROL_MESSAGE_SIZE を超える送信失敗で pending と予約を残さない」系、「送信失敗時に REGISTER の予約が取り消される」系、「subscribe: 送信失敗時は fill 関連付けと保留中の SUBSCRIBE が残らない」、「publish: 送信失敗後に close() しても unhandled rejection が発生しない」は、引き続き通る。これらは同期部 (フレーミング / `controlWriter` の確認) で予約と pending の登録より前に失敗する経路になるため、送信の try/catch や内部の孤児 Promise を前提にしたコメントを「予約も登録もしない」趣旨に直す
  - 「送信失敗時に REGISTER の予約が取り消される」系の 3 件 (publish / subscribe / fetch) は、予約を取り消す経路を通らなくなるため、「送信前の失敗では REGISTER を予約しない」の形に改名する (既存の「subscribe: 送信前の検証エラーで REGISTER の登録サイズが増えない」と同じ趣旨)。予約を取り消す経路は経路 4-4 の新しいテストが固定する
  - 「publish: write 失敗時にストリームが RESET で閉じられ pendingPublish が残らない」などの write 失敗時の解放のテストは、解放が reject の後に続くため、解放が完了するまで待ってから検証する (先例の「publishNamespace: write 失敗時にストリームリソースを掃除して Map に残さない」と同じ)
  - `src/session/bidiSendRequestOnBidiStream.test.ts` の「リクエストストリームの reader をセッションの受信上限で作る」は、`ControlStreamReader` を作る送信の async 部を対象に書き換え、reader が `localMaxControlMessageSize` で作られることを引き続き固定する。テストファイルは書き換え後の対象の関数名に合わせて改名し、ファイル冒頭のコメントとテスト名 (`"bidiSendRequestOnBidiStream: ..."`) も直す
- `bidiSendRequestOnBidiStream` / `requestsSendRequestOnBidiStream` を名前で参照しているコメント (`src/session/bidi.ts` の `sendRequestOnBidiStream` の節見出しのコメントと `bidiSendRequestMessage` の JSDoc / `src/session/requests.ts` のファイル冒頭と送信失敗の catch 内 / `src/session/dataStreamIncoming.ts` / `src/session/bidi.prop.ts` / `src/testSupport/bidi.ts` / `src/session/bidiReadRequestStreamMessages.test.ts` (テストファイル名 `bidiSendRequestOnBidiStream.test.ts` への参照を含む) / `src/session.test.ts`) を、分割後の関数名と責務に合わせて直し、削除した関数名の参照を残さない (`rg -i sendRequestOnBidiStream src docs` が 0 件になる)
- `src/session.ts` の `Session` インターフェースの `publish` / `subscribe` / `fetch` / `trackStatus` の JSDoc に、`publishNamespace` と同じ趣旨の契約を書く (「Session の終了時は、送信待ち (ストリーム作成 / write の await) の間を含めて、未確立の Promise を reject する」。§6.6。根拠の仕様はドラフトであり将来変更される可能性がある)。`publish` / `subscribe` には JSDoc 自体が無いため新設する
- `docs/LOW_LEVEL_API.md` の「通常の request stream」の導入文 (`sendRequestOnBidiStream()` を経由して送信する) と手順を新しい流れ (フレーミング → ストリーム作成 → 状態確認 → 予約と debug → 状態確認 → write → 状態確認 → `requestStreams` への登録と受信ループ) に直し、同じ契約と、送信完了後に Session が終了していた場合は受信ループを開始せずストリームを解放することを書く
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

`src/session/requests.ts` の `requestsPublish` / `requestsSubscribe` / `requestsFetch` / `requestsTrackStatus` を `async` 関数から同期関数に変え、Promise を送信より先に作って返すようにした。送信は 4 API で共通の detached な `requestsSendRequest` が行う。これにより、送信待ちの間に Session が終了しても、呼び出し元の Promise が終了の理由で settle する。

- 同期部: 検証・認可トークンの正規化・パラメータ構築・encode に加えて、`src/session/bidi.ts` の `bidiFrameRequestMessage` (`bidiSendRequestOnBidiStream` を置き換えた同期関数。`controlWriter` の確認とフレーミングだけを行う) を Promise の作成より前に呼ぶ。送信の入力 (`decoded` や Track 単位の追跡のキーを含む) も Promise の作成より前に組み立て、executor の中では pending の登録 (subscribe は fill の関連付けも) と `requestsSendRequest` の開始だけを行う
- `requestsSendRequest` は issue の手順 1〜5 (4-1〜4-4) どおりに進む。経路ごとに、同期の登録解除と reject (`requestsAbandonRequest`) を先に行い、ストリームの解放 (`requestsReleaseUnlockedStream` / `requestsReleaseLockedStream`) を最後に行う。Track 単位の追跡は pending から引き直さず、送信の入力が保持するキーで解放する。4-3 (debug コールバックの同期 close) は try の外で後始末し、catch と二重にならない構造にした
- `requestsSendRequestOnBidiStream` と、使われていなかった `requestsRead*Response` を削除した。`namespaces.ts` にあった同一の補助関数 (状態の読み出しとロック前のストリーム解放) は `requests.ts` から export したものに寄せた。`SessionImpl.requestStreams` の型は `bidi.RequestStreamInfo` にし、読み取り箇所が無くなった `BidiSessionInternal.localMaxControlMessageSize` を削除した
- `src/session.ts` の `Session` インターフェースの 4 メソッドに、送信待ちの間を含めて未確立の Promise を reject する契約を書いた (`publish` / `subscribe` は JSDoc を新設)。`SessionImpl` の各メソッドには、`async` が同期の throw を rejection に変えるために必要である旨を書いた
- `docs/LOW_LEVEL_API.md` の「通常の request stream」を、同期部と送信の async 部の手順 (コードと同じ番号)、契約、受信ループを開始しない場合の後始末に書き直した

テストは `src/session.test.ts` に、4 API それぞれについて次を追加した (`HELD_REQUEST_APIS` を回して生成する)。テスト用の transport は `createHeldBidiStreamTransport` (旧 `createHeldNamespaceTransport`) に改名し、作成の失敗 (`failCreate`) と cancel の保留 (`holdCancel`) を加えた。

- 同期部の失敗は同期で throw せず、reject する Promise を返す
- 手順 1: ストリーム作成の失敗で元のエラーで reject し、登録を残さない
- 手順 2: 作成待ちの間の close と、状態だけが閉じた場合 (内部状態の直接代入) で `"session closed"` で reject し、ロックを取らずに解放する
- 手順 3: writer 取得の失敗で元のエラーで reject し、`"request send failed"` で解放する
- 手順 4-1: 予約の失敗で、統計の加算・debug の send・write を起こさずに元のエラーで reject する。同じ Alias の REGISTER を並行して送っても、2 件目の失敗が 1 件目の予約を取り消さない
- 手順 4-2 / 4-3: debug コールバックの throw と同期 close (予約の取り消しを含む)
- 手順 4-4: REGISTER 付きの write の失敗で予約を取り消す (subscribe は fill の関連付けも残さない)。解放の保留中に close しても元のエラーで settle し、未処理の rejection が出ない
- 手順 5: write 待ちの間の自分からの close / ピア起点の close で、それぞれ `"session closed"` / `"session closed by peer"` で reject し、受信ループを開始せずに解放する (予約は残す)。ピア起点では fill の関連付けと Track 単位の追跡も解放する
- close 後に write が失敗しても未処理の rejection が出ず、catch 側が `"request send failed"` で後始末する

既存のテストのうち同期部で失敗するようになったものは、名前とコメントを「送信前の失敗」の趣旨に直した (REGISTER の予約系 3 件は「送信前の失敗では REGISTER を予約しない」に改名)。`src/session/bidiSendRequestOnBidiStream.test.ts` は `src/session/requestsSendRequest.test.ts` に書き換えて改名し、reader の受信上限の配線を実際の受信ループで確かめる形にした。条件待ちの `waitForCondition` を `src/testSupport/bidi.ts` に追加した。

`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」により更新していない。

### 残した課題

- create / write の await が解決しないまま Session が終了した場合の、送信中のストリームの解放 (本 issue の対象外。0939 と同型の follow-up が request 系にも要る)
- `sessionNotifyErrorIfActive` で状態だけが閉じ、かつ await が解決しない場合は Promise が settle しない (0936 の範囲)
- 送信の失敗で pending を消しても `onRequestDrained` を呼ばない (GOAWAY の drain)。予約が create の後になったため、予約の失敗もこの経路に入る。今回の変更より前からの挙動
- `statsControlMessagesSent` は write の前に加算するため、debug コールバックの throw / 同期 close では送っていないメッセージも数える。今回の変更より前からの挙動

## 参照

- `src/session/requests.ts` の `requestsPublish` / `requestsSubscribe` / `requestsFetch` / `requestsTrackStatus` / `requestsSendRequestOnBidiStream` / `requestsReserveAuthorizationToken` / `requestsReleaseAuthorizationToken`
- `src/session/bidi.ts` の `bidiSendRequestOnBidiStream` / `bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse` / `deleteFillFetchTarget` / `clearPriorGapTrackingIfUnused`
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests` / `sessionClose`
- `src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesSendPublishNamespace` (先例の形)
- `src/session.ts` の `Session` インターフェース / `SessionImpl` のコンストラクタの `transport.closed` の処理 / `SessionImpl.reserveAuthorizationTokenForSend`
- `src/session.test.ts` の `createHeldNamespaceTransport` / `createWriteFailureSession` と、publishNamespace の送信待ちのテスト群
- `src/session/bidiSendRequestOnBidiStream.test.ts`
- `docs/LOW_LEVEL_API.md` の「通常の request stream」
- closed の `0890-bug-publish-namespace-pending-settle.md` (先例)
- open の `0935-bug-debug-send-before-stream.md` (debug の send イベントの位置)
- open の `0936-bug-session-notify-error-pending.md` (`sessionNotifyErrorIfActive` が pending を reject しない)
- open の `0939-bug-publish-namespace-stream-release-on-stuck-write.md` (await が解決しない間のストリーム解放)
- draft-ietf-moq-transport-23 §6.6 (Termination) / §9.6 (SUBSCRIBE) / §9.8 (PUBLISH) / §9.11 (FETCH) / §9.12 (TRACK_STATUS)
- W3C WebTransport の `createBidirectionalStream()` (状態が `"closed"` / `"failed"` になると `InvalidStateError` で reject する) と送信ストリームの cleanup (保留中の write を reject する)
