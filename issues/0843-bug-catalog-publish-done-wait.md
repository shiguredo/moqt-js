# catalog 購読がエラー status の PUBLISH_DONE で終わっても待ちが解放されず、通知が二重になる

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-publish-done-wait
- Polished: 2026-11-10

## 目的

高レベル API の起動時、catalog の購読がエラーを示す Status Code の PUBLISH_DONE で終わっても catalog の待ちが解放されない。FETCH でも live のバッファでもフル catalog が得られない場合、`onError` が 1 回目 (PUBLISH_DONE 由来) と 2 回目 (受信タイムアウト由来) の 2 回呼ばれ、`start()` は受信タイムアウト (5 秒) まで待ってから `catalog receive timeout` で失敗する。1 つの終了で通知が 2 回になり、失敗の理由も実際の Status Code から `catalog receive timeout` に置き換わるため、relay の切り分けで誤った結論を導く。

PUBLISH_DONE の時点でフル catalog を持っている場合 (FETCH で適用済み、または live のバッファにある) は、現状でも `onError` は 1 回で、`start()` は FETCH の end か受信タイムアウトのドレインで resolve して成功する。この挙動は変えない。PUBLISH_DONE の時点で FETCH の応答がまだ届いておらず、かつ live のバッファにもフル catalog が無い場合は、現状は後から届く FETCH の catalog で成功し得るが、本変更では待たずに PUBLISH_DONE の Error で失敗させる (意図した挙動の変更。購読の確立そのものがエラーで終わっているため。devtools の catalog の `end` の「FETCH で catalog を取れる場合も、購読の確立そのものが失敗しているため待たない」と同じ判断であり、FETCH が応答しない場合 (0835 の状況) も受信タイムアウト (5 秒) まで失敗が遅れない)。

## 現状

- `src/createMediaSubscriber.ts` の `subscribeCatalog` は `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` への wrapper である。catalog の待ちは `tryResolveCatalog` の resolve (受信)、`rejectCatalogReceiveTimeout` の reject (受信タイムアウト)、`abortReceive` の reject (解放) でのみ決着する
- `CatalogSubscription.subscribe` は、catalog の受信を待つ Promise (`catalogResolve` / `catalogReject`) を `await session.subscribe(...)` と `assertStartNotDisposed` の後で作る。`src/session/bidi.ts` の `bidiReadSubscribeResponse` は SUBSCRIBE_OK と同じチャンクに連結されたメッセージを、`pending.resolve` の直後に同期で処理する (`bidiReadRequestStreamMessages` → `bidiHandlePublishDone` → `SubscriberImpl.handleEnd` → `end` コールバック)。そのため、SUBSCRIBE_OK と同じチャンクで PUBLISH_DONE が届くと、`end` は待ちを作る前に走る (`src/session/bidiRequestStreamInitialMessages.test.ts` の「bidiReadSubscribeResponse: SUBSCRIBE_OK と同一チャンクの PUBLISH_DONE も処理される」が、publisher が最初の Object を送らずに購読を終える状況として固定している)
- catalog の購読の `end` は `handlePublishDone` を呼ぶだけで、catalog の待ちを解放しない。エラー status の判定と Error の生成は `src/createMediaSubscriber.ts` の `resolvePublishDoneError` (内部で `isPublishDoneErrorStatus`) が行い、`PUBLISH_DONE with status 0x{code}: {reason}` (reason が空なら `PUBLISH_DONE with status 0x{code}`) の形の素の `Error` を返す
- FETCH フェーズ中は、FETCH の Object が届いてフル catalog を持っていても `tryResolveCatalog` は resolve を保留する (`catalogFetchInProgress` の間は return する)。FETCH の `end` と受信タイマーは `finishCatalogFetchPhase` でフェーズを終えてバッファをドレインし、フル catalog があれば resolve する (`src/createMediaSubscriber.media.test.ts` の「FETCH の応答が終わらないまま期限に達しても live のフル catalog で resolve する」)
- `rejectCatalogReceiveTimeout` は、`catalogResolve` / `catalogReject` を null に戻し、`resetCatalogFetchPhase` でフェーズ状態を解除し、`catalogReceiveFailed` を立てて reject する。受信タイマーの解除は、タイマーのコールバックと `subscribe` の `finally` の `clearCatalogTimer` が行う
- `MediaSubscriberImpl.start` は catalog の受信の後も `extractTrackInfo` / `createOutputStream` / `setupDecoders` / `subscribeMediaTracks` を続ける。音声・映像の購読の `end` は、`start()` の途中でも `handlePublishDone` を呼ぶだけで `start()` を失敗させない (`src/createMediaSubscriber.publish-done.test.ts` の「subscribeMediaTracks: エラー status の PUBLISH_DONE で映像の購読が onError に届く」)
- devtools (`devtools/src/hooks/useSubscriber.ts`) は catalog の受信を待つ Promise を `session.subscribe` の前に作り、最初の catalog で resolve する。catalog の購読の `end` はエラー status なら reject するが、catalog を受け取った後は resolve 済みのため no-op になる (受信前の終了だけが失敗になる)
- `src/createMediaSubscriber.publish-done.test.ts` の「subscribeCatalog: エラー status の PUBLISH_DONE で catalog の購読が失敗する」は、PUBLISH_DONE の後に待ちが解放されず、`close()` で打ち切る挙動を固定している

## 設計方針

エラー status の PUBLISH_DONE を、catalog の受信の待ちの状態ごとに次のように扱う。どの場合も、1 つの終了で `onError` を 1 回だけ呼ぶ。エラー status の判定と Error には `resolvePublishDoneError` の戻り値をそのまま使い、`CatalogSubscription` へは `filterPendingObjects` / `fetchFilter` と同じく依存 (`CatalogSubscriptionDependencies`) として注入する (`catalogSubscription.ts` から `createMediaSubscriber.ts` を import すると循環するため)。

- (a) 待ちを作る前 (SUBSCRIBE_OK と同じチャンクで PUBLISH_DONE が届き、`await session.subscribe` の継続より先に `end` が走る場合): `end` は Error を `subscribe()` のローカル変数に記録するだけにし、`handlePublishDone` を呼ばない。`subscribe()` は `await session.subscribe` と `assertStartNotDisposed` の直後に記録を確かめ、記録があれば待ち・タイマー・FETCH を作らずに `resetCatalogFetchPhase` してその Error を throw する。live のバッファは確かめない (SUBSCRIBE_OK より前に届いたデータストリームは alias が決まるまで `pendingSubgroupBuffer` で待ち、配送は非同期になる一方、`end` は SUBSCRIBE_OK の処理と同じ同期区間で購読を closed にするため、本番ではこの時点のバッファは空である)。購読は `catalogSubscriber` に代入済みのため、`start()` の巻き戻しが解放する。`onError` は `start()` の失敗経路が 1 回だけ通知する
- (b) 待ちの間 (待ちを作ってから決着するまで): FETCH の完了を待たずに、受信タイマーと同じく `finishCatalogFetchPhase` でフェーズを終えてバッファをドレインする。
  - フル catalog で resolve できた場合は、`handlePublishDone` で `onError` を 1 回呼び、`start()` を続ける (現状の成功を保つ)
  - resolve できなかった場合は、PUBLISH_DONE の Error で待ちを reject する。`end` からは `onError` を呼ばず、`start()` の失敗経路が `onError` を 1 回だけ通知する。受信タイムアウトを待たない
  - ドレイン中に `onCatalog` が throw した場合は、受信タイマーのドレインと同じく例外を `reportError` へ流し、待ちは (resolve できていなければ) PUBLISH_DONE の Error で reject する (`catalog receive timeout` では reject しない)。この経路の `onError` は `onCatalog` の例外と PUBLISH_DONE の 2 件になる (別の原因の通知であり、本 issue の「1 つの終了で 1 回」は PUBLISH_DONE の通知についての約束である)。どの経路でもドレイン中の例外を揃える open の 0836 は `rejectCatalogReceiveTimeout` で reject する設計のため、下の `rejectCatalogReceive(error)` への一般化の後は、契機ごとの Error を渡す形に合わせる必要がある (0836 側への追記事項)
- (c) 待ちの決着後 (`start()` の後段の実行中と `"active"` の間): `handlePublishDone` で `onError` を 1 回呼ぶ。`start()` は catalog の PUBLISH_DONE を理由に失敗しない (音声・映像の購読の `end` と同じ扱い)

あわせて次を行う。

- reject の後始末は、`rejectCatalogReceiveTimeout` を Error を引数に取る共通関数 (例: `rejectCatalogReceive(error)`) に一般化し、受信タイマーと (b) の reject の両方から使う。後始末の内容は現状の `rejectCatalogReceiveTimeout` と同じ (`catalogResolve` / `catalogReject` を null に戻す、`resetCatalogFetchPhase`、`catalogReceiveFailed` を立てる)。受信タイマーは reject を受けた `subscribe` の `finally` の `clearCatalogTimer` が解除する
- (a) / (b) / (c) の判定は「受信の待ちを作ったか」「待ちが決着したか」で行い、`catalogReject !== null` だけには頼らない。決着は resolve / reject が呼ばれた時点で同期に記録する (例: Promise の executor で、ローカルの決着フラグを立ててから元の resolve / reject を呼ぶ関数を `catalogResolve` / `catalogReject` に渡す)。`subscribe` の `await catalogPromise` の継続や `finally` で立てるフラグは使わない (resolve と継続の間に `end` が走ると (b) と誤判定し、すでに resolve 済みのため reject も通知も起きず `onError` が 0 回になる)。ローカルで包むことで、前の `start()` の購読の `end` が新しい待ちを誤って操作することも防ぐ
- (b) でドレインして resolve し起動を続けた場合は、受信タイムアウトでドレインしたときと同じく FETCH が保留のまま残る。open の 0835 は受信タイムアウトのドレインで resolve した時点だけを破棄の契機にしているため、0835 の破棄の契機に (b) のドレインによる resolve も加える必要がある (0835 側への追記事項)
- devtools とは、「受信前の終了は失敗、受信後の終了は通知だけ」で揃う。devtools 側は変更しない

### 対象外

- 正常な PUBLISH_DONE (TRACK_ENDED 等) の通知 (`0842-add-media-subscriber-normal-end.md` の範囲)
- 正常な status の PUBLISH_DONE で `start()` の受信の待ちが解放されない問題 (0842 も対象外としており未起票。別 issue の候補)
- catalog の購読の `error` (PUBLISH_DONE を伴わない FIN / RESET_STREAM) で同じく二重通知になる問題 (未起票。別 issue の候補)
- `CHANGES.md` の更新 (`CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール: CHANGES.md を更新しない」)

## 完了条件

- (a) SUBSCRIBE_OK と同じチャンクで届いたエラー status の PUBLISH_DONE (テストでは `session.subscribe` が Subscriber を返す前に `end` を呼ぶ) で、`start()` が PUBLISH_DONE の Error で失敗し、FETCH を送らず、`onError` が `start()` の失敗経路から 1 回だけ呼ばれる (`subscribeCatalog` 単体は PUBLISH_DONE の Error で reject するだけで `onError` を呼ばない)
- (b) 待ちの間にエラー status の PUBLISH_DONE が届き、フル catalog が得られないとき、`start()` が受信タイムアウトを待たずに PUBLISH_DONE の Error (`resolvePublishDoneError` の戻り値) で失敗し、`onError` が 1 回だけ呼ばれる
- (b) 待ちの間にエラー status の PUBLISH_DONE が届き、その時点で FETCH または live のバッファにフル catalog があるとき、`start()` は成功し、`onError` が 1 回だけ呼ばれる
- (b) 待ちの間にエラー status の PUBLISH_DONE が届き、その時点で FETCH の応答がまだ届いておらず、かつ live のバッファにもフル catalog が無いとき、後から FETCH の catalog が届いても `start()` は PUBLISH_DONE の Error で失敗し、`onError` が 1 回だけ呼ばれる
- (c) 待ちの決着後にエラー status の PUBLISH_DONE が届いたとき、`onError` が 1 回だけ呼ばれ、`start()` は失敗しない
- `src/createMediaSubscriber.publish-done.test.ts` の「subscribeCatalog: エラー status の PUBLISH_DONE で catalog の購読が失敗する」が新しい期待 (`end` の時点で `onError` は呼ばれず、`subscribeCatalog` が PUBLISH_DONE の Error で reject する) に追従する。既存の `src/createMediaSubscriber.media.test.ts` の catalog の受信タイムアウトのテストが通る
- `docs/HIGH_LEVEL_API.md` の `### start() の失敗` の `#### それ以外の Error` に、catalog の購読が受信前にエラー status の PUBLISH_DONE で終わった場合は `catalog receive timeout` ではなく `PUBLISH_DONE with status 0x{code}: {reason}` (reason が空なら `: {reason}` は付かない) の素の `Error` で失敗することを書く。`### カタログの受信` には、PUBLISH_DONE の時点でフル catalog が無ければ FETCH の応答を待たずに失敗すること (devtools と同じ判断) を書く
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通る

## 参照

- `src/createMediaSubscriber.ts` の `subscribeCatalog` (wrapper) / `start` / `handlePublishDone` / `resolvePublishDoneError`
- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` / `tryResolveCatalog` / `finishCatalogFetchPhase` / `rejectCatalogReceiveTimeout` / `abortReceive` / `CatalogSubscriptionDependencies` / `CATALOG_RECEIVE_TIMEOUT`
- `src/session/bidi.ts` の `bidiReadSubscribeResponse` / `src/session/bidiRequestStreamInitialMessages.test.ts`
- `src/createMediaSubscriber.publish-done.test.ts` / `src/createMediaSubscriber.media.test.ts` / `src/createMediaSubscriber.lifecycle.test.ts`
- `devtools/src/hooks/useSubscriber.ts` の catalog の購読の `end`
- `docs/HIGH_LEVEL_API.md` の `### start() の失敗` / `### カタログの受信`
- closed の `0840-change-subscriber-publish-done-reason.md` (終了通知の契約)
- open の `0835-bug-catalog-fetch-cancel.md` (FETCH が応答しない場合) / `0836-bug-catalog-drain-error-handling.md` (ドレイン中の例外) / `0842-add-media-subscriber-normal-end.md` (正常な PUBLISH_DONE の通知)
- draft-ietf-moq-transport-23 §9.9 (PUBLISH_DONE。Status Code と Error Reason)

## 解決方法

{未着手}
