# 高レベル購読で publisher の出現待ちを表現できない

- Created: 2026-11-02
- Completed: 2026-11-02
- Branch: feature/add-media-subscriber-rendezvous-timeout
- Polished: 2026-11-02

## 目的

1:N の live 視聴では、視聴者が配信者より先に接続するのが普通である。現状の高レベル購読は配信者の不在を購読の失敗として即座に返すため、「配信者が現れるまで待つ」を表現できず、アプリが指数バックオフの再試行を書くか再読み込みするしかない。draft-ietf-moq-transport-22 §9.20.6 の `RENDEZVOUS_TIMEOUT` を高レベル API から指定できるようにし、購読開始の失敗を再試行の可否で判断できる契約を `docs/HIGH_LEVEL_API.md` に定める。

## 現状

- `MediaSubscriberOptions` に `RENDEZVOUS_TIMEOUT` に相当する指定が無い。
- `CatalogSubscription.subscribe` は catalog の `SUBSCRIBE` に `filter: { nextObject: true }` と認可トークンだけを渡し、`MediaSubscriberImpl.subscribeMediaTracks` の音声と映像も認可トークンだけを渡す。`SubscribeOptions.rendezvousTimeout` は高レベル API から常に省略される。低レベル API の経路には実績があり、devtools は catalog / event timeline / 音声 / 映像の `SUBSCRIBE` に `rendezvousTimeout` を渡している (`devtools/src/hooks/useSubscriber.ts`)。
- draft-ietf-moq-transport-22 §9.20.6: `RENDEZVOUS_TIMEOUT` を省略した場合の既定は 0 であり、publisher が居なければ relay は即 `REQUEST_ERROR` (`DOES_NOT_EXIST`) を返す MUST。relay は要求より短い時間で `TIMEOUT` を返し得る (MAY)。
- その失敗は `session.subscribe` の reject として `start()` の失敗になり、`RequestError` (`RequestErrorCode.DOES_NOT_EXIST`) が throw されて `onError` にも渡る。ただし `docs/HIGH_LEVEL_API.md` は `start()` の失敗の型と、code による再試行可否の判断を定めていない。
- catalog の受信タイムアウト `CATALOG_RECEIVE_TIMEOUT` (5000 ms) は、`CatalogSubscription.subscribe` が `session.subscribe` を await する前にタイマーを張る。relay が publisher を待って `SUBSCRIBE_OK` を保留すると、5 秒時点で reject される `catalogPromise` にはまだハンドラが無く未処理の rejection になり、`SUBSCRIBE_OK` が 5 秒より後に届いても待ち時間が受信の猶予を食い潰しているため、購読確立の直後に `catalog receive timeout` で失敗する。
- `start()` の reject に載る値は `RequestError` だけではない。セッションの終了は素の `Error` (`session closed` / `session closed by peer`)、プロトコル違反は `SessionError`、接続の失敗は `WebTransportError` / `DOMException`、request stream の GOAWAY は素の `Error` (`request stream goaway`)、catalog の受信タイムアウトと解放による打ち切りも素の `Error`、`SUBSCRIBE_OK` の Malformed Track は `MalformedTrackError` である。`MalformedTrackError` はパッケージから export されていない。
- 高レベル購読は `SubscribeCallbacks.goaway` を設定しておらず、`ConnectCallbacks.goaway` も高レベル API へ配線されていない。そのため GOAWAY で示された新しい Session URI は捨てられている。
- 低レベル API には `SubscribeOptions.rendezvousTimeout` (ミリ秒、`bigint`) があるが、`docs/LOW_LEVEL_API.md` に記述が無い。
- `MediaSubscriberState` は `"created"` / `"subscribing"` / `"active"` / `"stopped"` / `"closed"` であり、待ちを表す状態は無い。

## 設計方針

- `MediaSubscriberOptions.rendezvousTimeout?: number` (ミリ秒) を追加し、catalog / 音声 / 映像の `SUBSCRIBE` に `SubscribeOptions.rendezvousTimeout` として渡す。低レベルの型は `bigint` なので変換する。
- 値の検証は `createMediaSubscriber` の生成時に行う (`preDecodeDelayMs` の `resolvePreDecodeDelayMs` と同じ配置)。ただし値の条件は異なり、0 以上 `Number.MAX_SAFE_INTEGER` 以下の整数に限る。負数・小数・非有限・上限超は拒否する。
- `0` を指定した場合は `RENDEZVOUS_TIMEOUT` 0 を載せる (即時応答を要求することを明示する)。未指定の場合は載せない (既定 0 と同じ挙動)。
- `rendezvousTimeout` は `SUBSCRIBE` ごとの上限である。`start()` は catalog → 音声 → 映像の最大 3 回の `SUBSCRIBE` を直列に待つため、`start()` 全体では最大 3 回分待ち得る。`docs/HIGH_LEVEL_API.md` にこのことを明記する。
- catalog の受信タイマーは `session.subscribe` が解決した後 (`SUBSCRIBE_OK` の処理後) に張る。待ちの間の未処理 rejection を無くし、rendezvous の待ち時間を受信の猶予に混ぜない。`SUBSCRIBE_OK` より前に届いたストリームのデータは捨てられるか、Track Alias の確立まで短時間バッファされてから購読に渡る (§3.1.3.1)。バッファされたデータは購読の確立後に適用されるため、タイマーの起点を `SUBSCRIBE_OK` にしてもタイマーの目的 (catalog Object の受信待ち) は変わらない。
- `start()` の失敗の契約を `docs/HIGH_LEVEL_API.md` に書く。再試行の判断は次の 3 分類で行う。
  - **relay の `REQUEST_ERROR`** は `RequestError` で届き、`instanceof RequestError` で判定できる。`code` と `retryInterval` (「ミリ秒 + 1」の生値であり、0 は「そのままでは再試行しない」) で判断する。
    - `DOES_NOT_EXIST` / `TIMEOUT`: publisher が居ない典型。再試行の対象。ただし `retryInterval` が 0 ならそのままでは再試行しない
    - `UNAUTHORIZED` / `EXPIRED_AUTH_TOKEN`: トークンを取り直して再試行する。媒体トラックは `getAuthorizationToken` の呼び直しでもよく、catalog は SETUP の `authorizationToken` を使うため `authorizationToken` を更新して `createMediaSubscriber` から作り直す必要がある
    - `MALFORMED_AUTH_TOKEN`: トークンの生成を直すまで再試行しない
    - `NOT_SUPPORTED`: 恒久の失敗
    - `GOING_AWAY` / `EXCESSIVE_LOAD` / `INTERNAL_ERROR`: `retryInterval` に従って再試行する
    - その他: `code` と `retryInterval` でアプリが判断する
  - **接続・セッションの失敗** は `RequestError` ではない (`SessionError` / `WebTransportError` / `DOMException` / 素の `Error`)。セッションが切断された場合、`onClose` は `start()` の失敗の後 (または前) に呼ばれる (`onError` と `onClose` が続けて呼ばれ得る)。接続先・証明書・relay の状態を確かめて再接続する。
  - **それ以外の `Error`** (`catalog receive timeout`、`MalformedTrackError`、解放による打ち切りなど) は型で再試行可否を区別できないため、本 issue の契約には含めない。アプリは再試行の前に購読要求 (namespace / track / 認可) を見直す。
- GOAWAY 由来の失敗は素の `Error` (`request stream goaway`) で届き、新しい Session URI は高レベル API では取得できない (`MediaSubscriberCallbacks` に goaway が無く、`session.subscribe` の goaway コールバックも設定していない)。draft-ietf-moq-transport-22 §9.2 は、URI が提供された場合にその URI を新しいセッションに使うことをクライアントへ MUST とする。本 issue ではこの URI を使う再接続を実装しない。`docs/HIGH_LEVEL_API.md` の GOAWAY の扱いに、高レベル API では §9.2 の MUST を満たせない制限と、URI を使う再接続が必要な場合は低レベル API の `ConnectCallbacks.goaway` / `SubscribeCallbacks.goaway` を使う必要があることを書く。URI を使う再接続の高レベル対応は本 issue の対象外とする。
- `onError` の通知回数は本 issue の対象外とする (`start()` の失敗と Session エラーで `onError` が重なる既存の挙動を変えない)。
- 待ちを表す状態は追加しない。待ちは `start()` が解決しない時間として表し、`"subscribing"` のまま待つことを文書化する。状態を増やすと状態遷移と既存の利用者の分岐を壊すためである。
- `close()` とピア起点の close は、保留中の `session.subscribe` を `sessionRejectPendingRequests` が reject するため待ちが打ち切られる (待ちが残って `start()` がハングしないことをテストで固定する)。
- 自動のバックオフ再試行と、複数 namespace を購読するプールは本 issue の範囲外とする。
- 実リレーの E2E は publisher の不在を作れる場合にだけ追加する (実リレーで通ることを確認できた経路だけ。`issues/0817-add-relay-tests.md` の方針)。作れなかった場合は確認結果を解決方法に記録する。

## 完了条件

- `rendezvousTimeout` を指定すると、catalog / 音声 / 映像の `SUBSCRIBE` に `RENDEZVOUS_TIMEOUT` が載る。`0` を指定した場合も 0 が載る
- 未指定では載らない (既定 0 のまま)
- `rendezvousTimeout` に負数・小数・非有限・`Number.MAX_SAFE_INTEGER` 超を渡すと `createMediaSubscriber` が拒否する
- catalog の受信タイムアウトが `SUBSCRIBE_OK` の後に数えられる。`SUBSCRIBE_OK` を 5000 ms より遅らせても、待ちの間に `catalog receive timeout` が発火せず、未処理の rejection も出ない (テストでは `subscribeCatalog` の `timeoutMs` に短い値を渡して固定する)
- relay が `TIMEOUT` / `DOES_NOT_EXIST` を返したとき、`start()` の失敗が `RequestError` で `code` と `retryInterval` を読める
- `start()` の待ちの間に `close()` またはピア起点の close が起きた場合に、待ちが打ち切られてハングしない
- 実リレーで `RENDEZVOUS_TIMEOUT` を送り、publisher 不在のときに `SUBSCRIBE_OK` が保留されるか `REQUEST_ERROR` (`TIMEOUT` / `DOES_NOT_EXIST`) が返ることを確認する。確認できた経路だけ E2E に追加し、publisher 不在を作れなかった場合は結果を解決方法に記録する
- `docs/HIGH_LEVEL_API.md` に `rendezvousTimeout` (SUBSCRIBE ごとの上限であり、`start()` 全体では rendezvous の待ちが最大 3 回分になること。catalog の受信はこれとは別に `SUBSCRIBE_OK` から 5000 ms) と `start()` の失敗の契約 (3 分類、`RequestError` の code と `retryInterval` の表、`onClose` のタイミング、GOAWAY の扱いと §9.2 の MUST を高レベル API では満たせない制限、対象外の失敗) を書く
- `docs/HIGH_LEVEL_API.md` の catalog の受信タイムアウトの記述を「`SUBSCRIBE_OK` を受けてから 5000 ms」に直す
- `docs/LOW_LEVEL_API.md` に `rendezvousTimeout` の意味 (SUBSCRIBE のみ、既定 0、relay が短縮し得る、publisher 不在のときの `DOES_NOT_EXIST` と期限切れの `TIMEOUT`、`REQUEST_ERROR` の Retry Interval (§9.4.2、`RequestError.retryInterval`) との関係) を書く
- `npx vp check` と `npx vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

`MediaSubscriberOptions.rendezvousTimeout` (`number`、ミリ秒) を追加した。0 以上 `Number.MAX_SAFE_INTEGER` 以下の整数だけを受け付け、負数・小数・非有限・上限超は `createMediaSubscriber()` の生成時に拒否する。値は `bigint` に変換して catalog / 音声 / 映像の `SUBSCRIBE` の `SubscribeOptions.rendezvousTimeout` として渡す。`0` を指定した場合は 0 のパラメータを載せ、未指定の場合は載せない (relay の既定も 0 だが、明示と省略を区別する)。

- catalog の受信タイムアウト (5000 ms) は `SUBSCRIBE_OK` を受けた後に数え始めるようにした。従来は `session.subscribe` の前にタイマーを張っており、relay が publisher の出現を待って `SUBSCRIBE_OK` を保留すると、購読確立の直後に `catalog receive timeout` で失敗し、待ちの間にハンドラの無い rejection も残り得た
- `start()` の失敗の契約を `docs/HIGH_LEVEL_API.md` に定めた。relay の `REQUEST_ERROR` は `RequestError` で届き、`code` と `retryInterval` (§9.4.2 の Retry Interval の生値、「ミリ秒 + 1」、0 はそのままでは再試行しない) を読める。`DOES_NOT_EXIST` / `TIMEOUT`、`UNAUTHORIZED` / `EXPIRED_AUTH_TOKEN`、`MALFORMED_AUTH_TOKEN`、`NOT_SUPPORTED`、`GOING_AWAY` / `EXCESSIVE_LOAD` / `INTERNAL_ERROR` の再試行の判断を表にした。接続・セッションの失敗 (`SessionError` / `WebTransportError` / `DOMException` / 素の `Error`) と、それ以外の `Error` (`catalog receive timeout`、`MalformedTrackError`、解放による打ち切り) も分類した
- GOAWAY の扱いを `docs/HIGH_LEVEL_API.md` に書いた。高レベル API は新しい Session URI を取得できず、§9.2 の「URI が提供されたら新しいセッションに使う MUST」を満たせない。URI を使う再接続は低レベル API の `ConnectCallbacks.goaway` / `SubscribeCallbacks.goaway` を使う必要があり、高レベル対応は対象外とした
- `docs/LOW_LEVEL_API.md` に `SubscribeOptions.rendezvousTimeout` の意味 (SUBSCRIBE のみ、既定 0、relay が短縮し得る、publisher 不在のときの `DOES_NOT_EXIST` と期限切れの `TIMEOUT`、Retry Interval との関係) を追加した
- `tests/e2e/main.ts` に `rendezvousTimeout` と、開始失敗の観測 (`RequestError` の `code` / `retryInterval`) を露出し、`tests/e2e/relay/rendezvous-timeout.spec.ts` を追加した。実リレー (2026-11-02) で、publisher 不在の namespace への購読が `rendezvousTimeout` 付きで `RequestError` (`TIMEOUT` / `DOES_NOT_EXIST`) として失敗すること、publisher が居る購読が `rendezvousTimeout` を指定しても購読確立することを確認した (2 passed)
- 待ちを表す状態は追加していない。`start()` が解決しない時間として待ち、`"subscribing"` のままであることは既存の状態遷移のままである
- 待ちの間の `close()` / ピア起点の close による打ち切りは、既存の `session.subscribe` の待ち中の close と catalog の受信待ち中の close のテストで固定されている (新しい reject 経路は無い)
- 確認: `npx vp check`、`npx vp test run` (4425 tests)、`npx vp run build`、実リレー E2E (`--project=relay`) 2 passed
- 対象外: GOAWAY の新しい Session URI を使う高レベル API の再接続、自動のバックオフ再試行、複数 namespace を購読するプール
- `CHANGES.md` は MOQT RFC ドラフト期間中のため更新していない

## 参照

- `src/codec/types.ts` の `MediaSubscriberOptions` / `MediaSubscriberState` / `MediaSubscriberCallbacks`
- `src/createMediaSubscriber.ts` の `MediaSubscriberImpl.start` / `connectToServer` / `subscribeMediaTracks` / `resolvePreDecodeDelayMs`
- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` / `CATALOG_RECEIVE_TIMEOUT` / `rejectCatalogReceiveTimeout`
- `src/session/publicTypes.ts` の `SubscribeOptions.rendezvousTimeout` / `SubscribeCallbacks.goaway` / `ConnectCallbacks.goaway`
- `src/session/params.ts` の `RENDEZVOUS_TIMEOUT` のエンコード
- `src/session/requests.ts` の `requestsSubscribe` (セッション終了後と GOAWAY 受信後の同期 throw)
- `src/session/bidi.ts` の `bidiReadSubscribeResponse` (REQUEST_ERROR / GOAWAY / Malformed Track の reject)
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests` (待ちの打ち切り)
- `src/error.ts` の `RequestError` / `RequestErrorCode` / `retryInterval` / `SessionError`
- `src/connect.ts` の `transport.ready` の失敗 (接続の失敗)
- `devtools/src/hooks/useSubscriber.ts` (低レベルの `rendezvousTimeout` の利用例)
- `docs/HIGH_LEVEL_API.md` の `MediaSubscriber` / catalog の受信タイムアウト / `start()` の失敗の記述
- draft-ietf-moq-transport-22 §3.1.3.1 / §9.2 / §9.4.2 / §9.20.6
- `issues/0817-add-relay-tests.md` (実リレーの E2E の方針)
- `issues/0884-add-high-level-connect-options.md` (同じ `MediaSubscriberOptions` と `docs/HIGH_LEVEL_API.md` の表を編集する。機能の重複は無いが、実装順によっては同じ箇所が競合する)
- `issues/0843-bug-catalog-publish-done-wait.md` (同じ `docs/HIGH_LEVEL_API.md` の `start()` の失敗の説明を更新する。内容は重ならない)
