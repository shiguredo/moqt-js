# SUBSCRIBE_TRACKS から確立した購読のハンドルをアプリへ渡せるようにする

- Created: 2026-11-12
- Completed: 2026-11-13
- Branch: feature/add-publish-established-callback
- Polished: 2026-11-12

## 目的

`TracksSubscriptionCallbacks` の `onPublish` は `SubscribeCallbacks` しか返せないため、PUBLISH から確立した購読の Track Properties と、購読を操作するハンドルをアプリが取得できない。

moqt-devtools が SUBSCRIBE_TRACKS で受信した映像を復号するには、次の 2 つが要る。

- Track Properties の TIMESCALE (0x08) / VIDEO_CONFIG (0x0D) / AUDIO_CONFIG (0x0F)。devtools の `buildVideoChunkPlan` は TIMESCALE を、`handleAudioObject` は AUDIO_CONFIG を購読ハンドルの `trackProperties` から読む。TIMESTAMP (0x10) は Object scope のみであり ([draft-ietf-moq-loc-05](refs/moq/draft-ietf-moq-loc-05.txt) §6.1 Table 1)、Track Properties からは読めない。Object ごとに `MoqtObject.properties` から読む
- 以後のキーフレーム要求 (`update`) と購読単位の解除 (`unsubscribe`) に使うハンドル

ハンドルを渡す時点では、Object が既に届き始めている可能性がある。アプリは Track Properties が揃うまで Object を保留し、`onPublishEstablished` で解放する (devtools が持つ `initData` の保留と同じ形)。そのため「最初の Object より先に呼ばれる」順序保証は求めず、ハンドルを渡すこと自体を目的にする。

代替経路が使えない理由は次のとおりである。

- **PUBLISH_OK では返せない**: draft-ietf-moq-transport-23 §9.3 は PUBLISH_OK に載せられるパラメータを EXPIRES のみとし、Track Properties は「they are empty in PUBLISH_OK」で、空でなければ INVALID_FIELD でセッションを閉じると定める。応答できる機会は §3.1 の「A subscriber MUST send exactly one PUBLISH_OK (Section 9.3) or PUBLISH_ERROR in response to a PUBLISH.」により 1 回だけであり、そこに初期値を載せる手段が無い
- **TRACK_STATUS では購読ハンドルが得られない**: `Session.trackStatus()` は `TrackStatusResult.trackProperties` で Track Properties を返せるが、得た値は PUBLISH から確立した購読には紐付かず、その購読を操作する `Subscriber` も得られない。`onPublish` の中で `trackStatus()` を await すれば確立を往復の分だけ遅らせられるが、その間の Object は `PendingSubgroupBuffer` の保留上限 (per-stream 1 MiB、`timeoutMs` 5000 ms) に収まる範囲でしか保持されず、Datagram は保留できないため取りこぼす。往復しても得られないのは購読ハンドルである
- **購読ハンドルはどこにも無い**: PUBLISH から生成した `Subscriber` は `SessionImpl` の内部 Map にだけ入り、`Session` の公開インターフェースに `subscribers` は無い。TRACK_STATUS ではハンドル自体も得られない。これが本 issue の中心的な理由である

したがって、PUBLISH の処理中の 1 点でだけアプリへ渡せる。

## 現状

- `src/session/publicTypes.ts` の `TracksSubscriptionCallbacks` は `onPublish` / `onPublishSkipped` / `error` / `goaway` の 4 つだけである。`onPublish` は `(namespaceSuffix, trackName) => SubscribeCallbacks | Promise<SubscribeCallbacks>` であり、Track Properties も購読ハンドルも返さない
- `src/session/incomingPublish.ts` の `incomingPublishHandleBidirectionalStream` は、`onPublish` の解決後に `SubscriberImpl` を生成し、`setSessionCallbacks` / `setTrackProperties` / `setGroupOrder` / `incomingPublishApplyParameters` / `setRangeFilters` を順に適用してから、`session.subscribers` / `subscribersByAlias` / `requestStreams` に登録し、`impl.onUnsubscribe` / `impl.onUpdate` を配線する
- 同じ関数はその後 `session.pendingSubgroupBuffer.notifyAlias(publishTrackAlias, "subscriber")` を呼び、`incomingPublishRegisterFillTarget` と `settleFillWaiters` を実行してから、`try` の中で PUBLISH_OK (REQUEST_OK) を `subWriter.write` で送り、`incomingPublishRunStreamSubLoop` を回す。§3.1 の MUST である
- 公開 API には `Subscriber` 型が既にある (`src/index.ts` が `src/subscriber.ts` から再エクスポートする)。`trackProperties` / `largestLocation` / `largestReceivedLocation` / `paused` / `state` / `update()` / `unsubscribe()` を持つ
- `src/subscriber.ts` の `Subscriber.trackProperties` の JSDoc は「SUBSCRIBE_OK で受信した Track Properties」であり、PUBLISH 由来を説明していない。`docs/LOW_LEVEL_API.md` の `Subscriber` 表も同じ記述である
- `docs/LOW_LEVEL_API.md` には `subscribeTracks()` 専用の節が無い。概要、認可トークンの注意、`Session` API 表の 1 行、「### Namespace 系の扱い」の中の 1 箇条に現れるだけで、`TracksSubscriptionCallbacks` の型名も `onPublish` / `onPublishSkipped` も一度も出てこない。契約を書く場所として使えるのは「### Namespace 系の扱い」だけである
- moqt-devtools は `devtools/src/hooks/useSubscriber.ts` で `session.subscribe()` による SUBSCRIBE だけを使う。SUBSCRIBE_TRACKS は使っておらず、`devtools/src/testSupport/fakes.ts` の `FakeSession.subscribeTracks` は未対応として throw する

## 設計方針

### 追加する API

`TracksSubscriptionCallbacks` に `onPublishEstablished` を追加する。

```ts
/**
 * PUBLISH から購読が確立したときに呼ばれる
 *
 * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
 * @param trackName - PUBLISH に含まれる Track Name
 * @param subscriber - 確立した購読のハンドル
 * @param callbacks - onPublish が返した SubscribeCallbacks (購読の対応付け用)
 */
onPublishEstablished?: (
  namespaceSuffix: string[],
  trackName: string,
  subscriber: Subscriber,
  callbacks: SubscribeCallbacks,
) => void;
```

- 既存の `onPublish` の契約は変えない。`onPublish` は `SubscribeCallbacks` を返す契約であり、戻り値の形を変えずに済むよう任意のコールバックを 1 つ足す
- 新しいハンドル型を作らず、既に公開している `Subscriber` をそのまま渡す。`onPublish` が返した `SubscribeCallbacks` の `object` コールバックと同じ購読を指す
- `onPublish` が返した `SubscribeCallbacks` を第 4 引数でも渡す。§3.1 は同一 Track への複数同時購読を許すため、同じ `namespaceSuffix` / `trackName` の PUBLISH が複数届くと、`Subscriber` だけではどの `SubscribeCallbacks` に対応する購読かを区別できない。`onPublish` の中で購読ごとの状態を作り、この引数との同一性 (`===`) で対応付ける
- 戻り値は `void` とする。同期のコールバックだけを受け付け、async 関数を渡した場合の reject は観測しないことを JSDoc に明記する (`SubscribeCallbacks.object` など既存のコールバックと同じ扱い)。async 関数が reject すると unhandled rejection になることも JSDoc に書く

### 呼び出し位置

PUBLISH_OK の write の成功後、`session.pendingSubgroupBuffer.notifyAlias(publishTrackAlias, "subscriber")` の直前に呼ぶ。あわせて PUBLISH_OK の write を `notifyAlias` より前へ移す。

現在の順序は次である。

1. `session.subscribers` / `subscribersByAlias` / `requestStreams` への登録と `onUnsubscribe` / `onUpdate` の配線
2. `notifyAlias`
3. `incomingPublishRegisterFillTarget` と `settleFillWaiters`
4. PUBLISH_OK の write
5. サブループ

これを次の順序にする。

1. 登録と配線
2. `incomingPublishRegisterFillTarget` と `settleFillWaiters`
3. PUBLISH_OK の write
4. `onPublishEstablished`
5. `notifyAlias`
6. サブループ

順序を入れ替える理由は次のとおりである。

- **§3.1 の Established にしてから渡す**: §3.1 の状態機械は、subscriber が PUBLISH_OK を送ることで Pending (Publisher) から Established に遷移すると定める。§9.5 は subscriber が送れる REQUEST_UPDATE を「a subscription established with PUBLISH」に対する操作として定め、§3.6.2 も「in a REQUEST_UPDATE following PUBLISH_OK」と書く。PUBLISH_OK の前に `update()` を呼べる状態でハンドルを渡すと、ピアが §9.5 の「other than in the two cases above」と解釈して UNEXPECTED_MESSAGE でセッションを閉じる余地が残る。PUBLISH_OK の write を先に済ませれば、コールバックの中で `update()` を呼んでも確立済みの購読に対する更新になる。`requestStreams` に登録済みの同一 writer へ書くため、ストリームの順序で PUBLISH_OK が先に届く
- **`unsubscribe()` を壊さない**: `bidiCancelSubscription` は `requestStreams` から writer を引いて abort する。PUBLISH_OK の write より前に `unsubscribe()` を呼べると、その後の write が abort 済みの writer で失敗し、§3.1 の MUST である PUBLISH_OK が送られないまま購読が消える。write を先に済ませれば、`unsubscribe()` は PUBLISH_OK 送信後の解除になる
- **`object` コールバックの前に呼ぶことを保証しない**: `subscribersByAlias` への登録と `incomingPublishRegisterFillTarget` は write より前に済むため、PUBLISH_OK の write を待つ間にも配送が始まり得る。次の 4 経路はいずれも `onPublishEstablished` より先に `object` コールバックを呼び得る
  - Datagram: `subscribersByAlias` を引いて即座に `handleDatagram` / `handleObject` を呼ぶ。Datagram には保留機構が無い
  - PUBLISH の後に届いた通常の Subgroup ストリーム: 保留を挟まずに配送される
  - 初期 fill: `settleFillWaiters` の解決後に `handleFillObject` が `object` コールバックを呼ぶ
  - PUBLISH より前に到着して `PendingSubgroupBuffer` に保留されていた Subgroup: write の await 中に FIN を検出すると、`dataStreamHandlePendingSubgroupStream` の FIN 分岐が `entry.notified` を待たずに `subscribersByAlias` を引いて合流するため、先に配送され得る
- **順序保証が無いことを JSDoc と docs に明記する**: アプリは `object` コールバックの中で Track Properties が未取得の間 Object を保留し、`onPublishEstablished` で保留を解放する。`onPublishEstablished` が呼ばれない経路 (PUBLISH_OK の write 失敗、セッション終了、`onPublish` の await 中に一致が失効した場合) でも保留を解放できるよう、アプリは自身の `SubscribeCallbacks.error` / `end` でも保留を破棄する必要がある。セッションの終了では `error` / `end` は呼ばれないため、`ConnectCallbacks.close` でも破棄する必要がある。ただし `SubscribeCallbacks.error` は `object` などのコールバック例外でも呼ばれ、そのとき購読は active のまま確立通知が来る (`error` の受信だけで確立しないと判断しないこと)。`end` (PUBLISH_DONE) はサブループ開始後にしか処理されないため、`onPublishEstablished` より先に来ることはない
- **登録をコールバックの後ろへ移さない理由**: `subscribersByAlias` への登録をコールバックの後ろへ移すと、write の await 中に届いた Datagram が保留先を失って取りこぼされる。Datagram には保留機構が無いため、登録は write より前に置く必要がある
- **初期 fill の受信先は write より前に登録する**: `settleFillWaiters` が待機中の FETCH_HEADER を即座に起こす。待機自体は `session.waitForPublishFillTarget` が受け持つため (`publishFillReadyCallbacks` に登録して待ち、解除後に `fillFetchTargets` を再検索する)、登録が後でも FETCH_HEADER を取りこぼさない。write より前に置くのは、待機のタイムアウト (`PUBLISH_FILL_WAIT_TIMEOUT_MS`) に頼らず関連付けるためである

コールバックを呼ぶ前に `impl.state === "active"` を確認し、closed なら呼ばない。write を待つ間に malformed track の検出が走ると `bidiCancelSubscriptionWithError` が購読を閉じるため、その場合に closed のハンドルを渡さないようにする。これにより「渡る `Subscriber` の `state` が `"active"` である」を保証する。

write の失敗時は、従来どおり catch で session 終了起因なら `markClosed`、それ以外は `notifySubscriberFailure` に進み、finally の後始末を行う。`notifyAlias` が write の後ろへ移るため、write に失敗した PUBLISH の `PendingSubgroupBuffer` の保留 Object は自購読の `notifyAlias` では解放されずにタイムアウトする (既定 5000 ms)。ただし、write の await 中に FIN を検出して合流した保留 Subgroup は、この時点で既に配送済みになり得る。Datagram / 新規 Subgroup / 初期 fill も write の成否と独立に配送され得る。したがって「確立しなかった購読に Object を届けない」は write 失敗の経路では保証されず、アプリは `SubscribeCallbacks.error` / `end` とセッション終了でも保留を破棄する必要がある。

### コールバックの例外

アプリのコールバックが throw しても、購読の確立とサブループを止めない。

- アプリケーションの例外はプロトコル違反ではない
- `src/session/namespaceLoops.ts` の `namespaceInvokeCallbackQuiet` が、`onNamespace` / `onNamespaceDone` の例外を握り潰して後始末を止めない方針を既に採っている。これに揃える
- PUBLISH_OK の write はコールバックより前なので、例外の有無で応答が変わらない
- 例外を通知する経路は追加しない。握り潰したことをアプリへ伝える手段が無いため、JSDoc に握り潰すことを明記する

### 認可トークンの引き継ぎ

PUBLISH から生成する `SubscriberImpl` に、購読を確立した `SUBSCRIBE_TRACKS` の Authorization Token を引き継ぐ (`impl.setAuthorizationToken(match.subscription.authorizationToken)`)。

- draft-ietf-moq-msf-01 §11.4.3 は、track に関連するトークンを、その Track に関係し AUTHORIZATION TOKEN パラメータを受け付けるすべての制御メッセージへ MUST 付与すると定める。`REQUEST_UPDATE` もその対象である
- draft-ietf-moq-transport-23 §3.6.2 は `SUBSCRIBE_TRACKS` のトークンを「`SUBSCRIBE_TRACKS` 自体に適用される」ものとし、`PUBLISH` から始まる購読の初期パラメータとしては扱わない (「The publisher uses the others as the initial Subscription parameters」の "others" に含めていない)。両者は読みが分かれるため、認可で拒否されない安全側を取り、購読に引き継ぐ
- 値は `requestsTokenForRequestUpdate` で `REQUEST_UPDATE` 用に正規化済み (REGISTER 済みの Alias は USE_ALIAS) であり、再変換しない
- PUBLISH が運ぶトークンは publisher 側の値であり、subscriber が `REQUEST_UPDATE` に載せる値ではない
- 引き継がないと、`onPublishEstablished` から呼ぶ `update()` (キーフレーム要求など) がトークン無しで送られ、publisher に UNAUTHORIZED で拒否され得る

### 既存の記述の是正

`Subscriber.trackProperties` は PUBLISH 由来の購読でも PUBLISH の Track Properties が入る。JSDoc と `docs/LOW_LEVEL_API.md` の `Subscriber` 表を「SUBSCRIBE_OK / PUBLISH で受信した Track Properties」に直す。

### 高レベル API は変更しない

`createMediaSubscriber` は Catalog を購読して codec を解決する設計であり、SUBSCRIBE_TRACKS の「prefix に一致する Track が事前に分からない」購読を扱う前提になっていない。今回は低レベル API の拡張に限定する。

### 対象外

- PUBLISH_OK の送信を debug コールバックへ出すこと。応答の観測性であり、購読ハンドルの受け渡しとは別の目的である
- `statsControlMessagesSent` の加算。自 endpoint が自動で返す応答は加算しない扱いが既にある (`respondToPublishRequestUpdate` と `incomingSendRequestErrorAndClose` は加算しない)

## 完了条件

- `TracksSubscriptionCallbacks` に `onPublishEstablished` がある
- PUBLISH 1 通に対して `onPublishEstablished` が高々 1 回呼ばれる。同じ Track に複数の PUBLISH が届けば、PUBLISH ごとに 1 回ずつ呼ばれる (draft-ietf-moq-transport-23 §3.1 は同一 Track への複数 PUBLISH を許す)
- 渡る `namespaceSuffix` / `trackName` は `onPublish` に渡る値と同じである
- `onPublishEstablished` に渡る `Subscriber` の `state` が `"active"` である。PUBLISH_OK の write を待つ間に購読が closed になった場合は呼ばない
- `onPublishEstablished` に渡る `Subscriber` の `trackProperties` が PUBLISH の Track Properties と一致し、`largestLocation` が PUBLISH の LARGEST_OBJECT と一致し、`paused` が PUBLISH の PAUSED と一致する
- `onPublishEstablished` の中で `subscriber.update()` と `subscriber.unsubscribe()` を呼んでも、PUBLISH_OK の write と §3.1 の状態遷移を壊さない
- `onPublishEstablished` から呼ぶ `update()` の `REQUEST_UPDATE` に、購読を確立した `SUBSCRIBE_TRACKS` の Authorization Token が載る
- `onPublishEstablished` が throw しても、PUBLISH_OK が送られ購読が active のまま残る
- `onPublishEstablished` の JSDoc が、`object` コールバックより後に呼ばれる場合があること (Datagram / PUBLISH 後の新規 Subgroup / 初期 fill / FIN で合流した保留 Subgroup) と、その場合にアプリがどう待つべきかを明記している
- `onPublishEstablished` の JSDoc が、PUBLISH_OK の write 失敗、セッション終了、`onPublish` の await 中の一致失効では呼ばれず、それらの経路でもアプリが保留を破棄する必要があることを明記している。あわせて `SubscribeCallbacks.error` はコールバック例外でも呼ばれ、そのとき確立通知が来ることを明記している
- `src/subscriber.ts` の `Subscriber.trackProperties` の JSDoc と `docs/LOW_LEVEL_API.md` の `Subscriber` 表が、PUBLISH 由来の購読でも値が入ることを示している
- `docs/LOW_LEVEL_API.md` の「### Namespace 系の扱い」に、`TracksSubscriptionCallbacks` の `onPublish` / `onPublishSkipped` / `onPublishEstablished` の契約と呼び出し順を追記する (`subscribeTracks()` 専用の節は現状無いため、既存の箇条の下に追加する)
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/publicTypes.ts` の `TracksSubscriptionCallbacks` / `SubscribeCallbacks` / `TracksSubscription` / `TrackStatusResult`
- `src/subscriber.ts` の `Subscriber` インターフェース
- `src/session/incomingPublish.ts` の `incomingPublishHandleBidirectionalStream` / `incomingPublishApplyParameters` / `incomingPublishRegisterFillTarget` / `incomingPublishMatchToSubscription`
- `src/session/bidi.ts` の `bidiCancelSubscription` / `bidiSendRequestUpdate` / `bidiHandlePublishRequestUpdate`
- `src/session/namespaceLoops.ts` の `namespaceInvokeCallbackQuiet`
- `src/pendingSubgroupBuffer.ts` の `PendingSubgroupBuffer.notifyAlias`
- `src/session/dataStreamIncoming.ts` の `dataStreamHandlePendingSubgroupStream` (保留 Object の再開)
- `src/session.test.ts` の `setupIncomingPublishStreamSession` / `createIncomingPublishStream` / `waitForIncomingPublishSubscriber`
- `docs/LOW_LEVEL_API.md` の「### Namespace 系の扱い」と `Subscriber` 表
- draft-ietf-moq-transport-23 §3.1 (Subscriptions) / §3.1.3.1 (Unknown Track Alias) / §3.6 (Subscribing to Tracks by Prefix) / §9.3 (REQUEST_OK) / §9.5 (REQUEST_UPDATE) / §9.8 (PUBLISH)
- draft-ietf-moq-loc-05 §6.1 Table 1 (LOC Property の scope)

## 解決方法

`TracksSubscriptionCallbacks` に `onPublishEstablished` を追加し、PUBLISH から確立した購読のハンドルと初期値をアプリへ渡せるようにした。

- `onPublishEstablished(namespaceSuffix, trackName, subscriber, callbacks)` を追加した。`subscriber` は確立した購読のハンドル、`callbacks` は `onPublish` が返した `SubscribeCallbacks` である
  - 同一 Track への複数 PUBLISH (§3.1) で購読を取り違えないよう、第 4 引数との同一性 (`===`) で対応付けられるようにした
- 呼び出し位置は PUBLISH_OK の write 成功後、`notifyAlias` の直前とした。§3.1 の Established になる前にハンドルを渡すと、コールバック内の `update()` が §9.5 の 2 ケース外になり、`unsubscribe()` は writer を abort して PUBLISH_OK を送れなくなる
- `impl.state === "active"` と `session.sessionState === "connected"` を確認してから呼ぶ。write の待ちの間に購読が閉じられた場合とセッションが終了した場合に、closed のハンドルを渡さない
- アプリのコールバック例外は握り潰す。アプリケーションのエラーはプロトコル違反ではなく、PUBLISH_OK は既に送信済みであるため購読の確立を止める理由が無い (`namespaceInvokeCallbackQuiet` と同じ方針)
- PUBLISH_OK の write を `notifyAlias` より前へ移した。これにより write に失敗した PUBLISH の保留 Subgroup は `notifyAlias` が呼ばれないまま残るため、`incomingPublishCleanupIncomingPublish` で `notifyAlias` を呼んで破棄するようにした。残すと、同じ alias を再利用した別 Track の PUBLISH が確立した際に旧 Track の Object が合流する (§3.1.3 の SHOULD に反する)
- 受信 PUBLISH から生成する `SubscriberImpl` に、購読を確立した SUBSCRIBE_TRACKS の Authorization Token を引き継いだ。引き継がないと、`onPublishEstablished` から呼ぶ `update()` がトークン無しで送られ、publisher に UNAUTHORIZED で拒否され得る (msf-01 §11.4.3 の MUST)
- `dataStreamIncoming.ts` の診断メッセージを「alias に購読が無い」に変えた。確立通知の中で解除する正規経路でも通るため、「race した稀なケース」を表す文言は適切でない
- `Subscriber.trackProperties` の JSDoc と `docs/LOW_LEVEL_API.md` の `Subscriber` 表を、PUBLISH 由来の購読でも値が入る記述に直した。LOC の TIMESTAMP は Object scope のみであることも明記した
- `docs/LOW_LEVEL_API.md` の「### Namespace 系の扱い」に `TracksSubscriptionCallbacks` の契約と呼び出し順を追記した。詳細な契約は JSDoc を正本とする
- テストを 10 件追加した。確立通知の引数と初期値、PUBLISH_OK の write 順序、コールバック内の `unsubscribe()` / `update()`、例外の握り潰し、write 中の購読 close とセッション終了、write 失敗時の非通知、Authorization Token の引き継ぎ、保留 Subgroup の破棄、複数 PUBLISH の対応付けである
- 検証: `vp check` / `vp exec tsc --noEmit` / `vp test run` (277 ファイル、5151 テスト) が通る
