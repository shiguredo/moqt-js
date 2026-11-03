# 高レベル API で GOAWAY の新しい Session URI を使った再接続ができない

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/add-high-level-goaway-migration
- Polished: 2026-11-03

## 目的

draft-ietf-moq-transport-22 §9.2 は、GOAWAY で新しい Session URI が提供された場合、クライアントがその URI を新しいセッションに使うことを MUST とする。高レベル API (`createMediaSubscriber` / `createMediaPublisher`) はこの URI を受け取る入口が無く、MUST を満たせない。relay のメンテナンスや負荷分散で GOAWAY が届いたとき、視聴・配信を新しい Session へ移行できない。

## 現状

- `ConnectCallbacks.goaway` (`src/session/publicTypes.ts`) は `(newSessionUri: string) => void` であり、Session の制御ストリームで GOAWAY を受けたときに `src/session/lifecycle.ts` の `sessionHandleGoaway` が呼ぶ。低レベル API では利用できる
- リクエストストリーム上の GOAWAY は別経路である。`src/session/namespaceLoops.ts` の `namespaceHandleGoaway` は重複 GOAWAY の検証と `SubscribeCallbacks.goaway` / `NamespacePublicationCallbacks.goaway` の通知を行い、新しい Session URI を返す。確立前は `namespaceHandleGoawayMessage` が保留中の Promise を `Error("request stream goaway: ...")` で reject する。確立後は reject せず、送信方向を FIN で閉じて読み取りを継続する
- `src/session/bidi.ts` の 4 つの `handleGoaway` (PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS の応答待ち) はすべて確立前の経路であり、pending を削除して `Error("request stream goaway")` で reject する。確立後は `closeOldRequestStreamOnGoaway` が `goawayCallback` を呼ぶだけで reject しない
- 高レベル API の接続は `src/createMedia/connect.ts` の `connectMediaSession` が組み立て、`ConnectCallbacks` の `close` と `error` は `MediaConnectSettings.onSessionClose` / `onSessionError` へ配線しているが、`goaway` は配線していない (`MediaConnectSettings` に goaway のフィールドが無い)
- `MediaSubscriberCallbacks` と `MediaPublisherCallbacks` (`src/codec/types.ts`) は `onStateChange` / `onError` / `onClose` (購読は `onCatalog` も) だけを持ち、goaway の通知が無い
- `src/createMediaSubscriber.ts` の `session.subscribe` の `SubscribeCallbacks` に goaway を渡しておらず、`src/mediaSubscriber/catalogSubscription.ts` の catalog の購読と `subscribeMediaTracks` の音声・映像の購読が該当する。`src/createMediaPublisher.ts` の `announceNamespace` の `NamespacePublicationCallbacks` も `error` だけを渡している
- そのため、GOAWAY 由来の失敗は素の `Error` (`request stream goaway` / `request stream goaway: <URI>`) として `start()` の失敗や `onError` に届き、新しい Session URI は捨てられる
- `docs/HIGH_LEVEL_API.md` の「start() の失敗」の「GOAWAY の扱い」は、この制限と低レベル API を使う必要がある旨を記載している

## 設計方針

新しい Session URI を使った再接続の扱いは、次の 2 案を比較して決めた。

- 通知だけ行う: `MediaSubscriberCallbacks` / `MediaPublisherCallbacks` に `onGoaway?: (newSessionUri: string) => void` を足し、URI をアプリへ渡す。再接続はアプリが行う。ライブラリの自動再接続は状態機械と購読の引き継ぎが大きく、本 issue の範囲を超える
- 自動で移行する: 高レベル API が内部で新しい Session を張り直し、catalog と媒体トラックの購読 (または PUBLISH) を引き継ぐ。`MediaSubscriberState` / `MediaPublisherState` に移行中の状態が要り、`stop()` / `close()` との競合も決める必要がある

本 issue では **通知だけ** (URI をアプリへ渡す) を実装する。自動移行 (新しい Session を張り直して購読 / PUBLISH を引き継ぐ) は本 issue の対象外とし、必要になったら別 issue にする。実装内容は次のとおり。

- `MediaConnectSettings` に `onSessionGoaway?: (newSessionUri: string) => void` を足し、`connectMediaSession` で `ConnectCallbacks.goaway` に配線する。高レベル API の callbacks (`MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway`) へ流す
- リクエストストリーム上の GOAWAY は、`session.subscribe` の `SubscribeCallbacks.goaway` と `publishNamespace` の `NamespacePublicationCallbacks.goaway` にも渡し、同じ `onGoaway` へ流す。同じ GOAWAY が Session とリクエストストリームの両方で届くと 2 回呼ばれ得るため、高レベル側では同じ URI の通知を 1 回に抑止する (低レベルは `session.receivedGoaway` とリクエストストリームの重複チェックを別々に持つ)
- Session の GOAWAY はセッションを即座には閉じない (§6.6.1 の NO_ERROR クローズは購読の終了を待つ)。`onGoaway` の通知後に `onClose` が続くことを契約に書く
- 再接続はアプリが `onGoaway` の URI を使って行う。ライブラリは自動で再接続しない

`docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」を、「`onGoaway` で新しい Session URI を受け取り、アプリが再接続する。ライブラリは自動移行しない」という契約に書き直す。「§9.2 の MUST を高レベル API では満たせない」という現在の記述は、`onGoaway` の追加で解消する。

## 完了条件

- `MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway` が新しい Session URI を受け取れる (テストで固定する)。Session の制御ストリーム由来とリクエストストリーム由来の両方で確認する
- コールバックを省略した場合の既存の挙動 (GOAWAY 由来の失敗が素の `Error` で届く) が変わらないことをテストで固定する
- `docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」を「`onGoaway` で URI を受け取りアプリが再接続する。ライブラリは自動移行しない」に書き換え、「§9.2 の MUST を高レベル API では満たせない」という記述を解消する。`onGoaway` と `onClose` の順序も書く
- 実リレーで GOAWAY を発生させる経路があれば E2E を追加する。無ければ確認した内容を解決方法に記録する
- `npx vp check` と `npx vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

{未着手}

## 参照

- `src/session/publicTypes.ts` の `ConnectCallbacks.goaway` / `SubscribeCallbacks.goaway` / `NamespacePublicationCallbacks.goaway`
- `src/session/lifecycle.ts` の `sessionHandleGoaway` (Session の GOAWAY 通知) と `sessionCloseIfGoawayDrained`
- `src/session/namespaceLoops.ts` の `namespaceHandleGoaway` (リクエストストリームの GOAWAY 通知)
- `src/createMedia/connect.ts` の `connectMediaSession` / `MediaConnectSettings`
- `src/createMediaSubscriber.ts` の `MediaSubscriberImpl.connectToServer` / `subscribeMediaTracks`
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.connectToServer` / `announceNamespace`
- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe`
- `src/codec/types.ts` の `MediaSubscriberCallbacks` / `MediaPublisherCallbacks`
- `docs/HIGH_LEVEL_API.md` の「start() の失敗」の「GOAWAY の扱い」
- `tests/e2e/main.ts` の `window.__moqtE2E`
- draft-ietf-moq-transport-22 §6.6.1 / §9.2
