# 高レベル API で GOAWAY の新しい Session URI を使った再接続ができない

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/add-high-level-goaway-migration
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §9.2 は、GOAWAY で新しい Session URI が提供された場合、クライアントがその URI を新しいセッションに使うことを MUST とする。高レベル API (`createMediaSubscriber` / `createMediaPublisher`) はこの URI を受け取る入口が無く、MUST を満たせない。relay のメンテナンスや負荷分散で GOAWAY が届いたとき、視聴・配信を新しい Session へ移行できない。

## 現状

- `ConnectCallbacks.goaway` (`src/session/publicTypes.ts`) は、`connect()` で GOAWAY を受けたときに新しい Session URI を渡す。低レベル API では利用できる
- 高レベル API の接続は `src/createMedia/connect.ts` の `connectMediaSession` が組み立て、`ConnectCallbacks` の `close` と `error` は `MediaConnectSettings.onSessionClose` / `onSessionError` へ配線しているが、`goaway` は配線していない
- `MediaSubscriberCallbacks` と `MediaPublisherCallbacks` に goaway の通知は無い。`src/createMediaSubscriber.ts` の `session.subscribe` の `SubscribeCallbacks` にも goaway を渡していない (`src/mediaSubscriber/catalogSubscription.ts` の catalog の購読と `subscribeMediaTracks` の音声・映像の購読が該当する)
- そのため、GOAWAY 由来の失敗は素の `Error` (`request stream goaway`) として `start()` の失敗や `onError` に届き、新しい Session URI は捨てられる
- `docs/HIGH_LEVEL_API.md` の「start() の失敗」の「GOAWAY の扱い」は、この制限と低レベル API を使う必要がある旨を記載している

## 設計方針

新しい Session URI を使った再接続を高レベル API で行うかを決める。候補は次のとおり。

- 通知だけ行う: `MediaSubscriberCallbacks` / `MediaPublisherCallbacks` に `onGoaway?: (newSessionUri: string) => void` を足し、URI をアプリへ渡す。再接続はアプリが行う。ライブラリの自動再接続は状態機械と購読の引き継ぎが大きく、本 issue の範囲を超える
- 自動で移行する: 高レベル API が内部で新しい Session を張り直し、catalog と媒体トラックの購読 (または PUBLISH) を引き継ぐ。`MediaSubscriberState` / `MediaPublisherState` に移行中の状態が要り、`stop()` / `close()` との競合も決める必要がある

まずは通知だけ (URI をアプリへ渡す) を推奨する。`connect()` の `ConnectCallbacks.goaway` と `subscribe` の `SubscribeCallbacks.goaway` のどちらで届いたか (Session 全体か request stream か) を区別できる形にし、アプリが新しい Session を張れるだけの情報 (URI) を渡す。`docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」を、実装後の契約に合わせて書き直す。

自動移行まで含めるかどうかは、実装着手時に決める。含める場合は `docs/ARCHITECTURE.md` の状態遷移も更新する。

## 完了条件

- GOAWAY を受けたとき、高レベル API のコールバックで新しい Session URI を受け取れる (テストで固定する)
- 上記のコールバックが無い場合 (省略時) の既存の挙動 (素の `Error` で失敗する) が変わらないことをテストで固定する
- `docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」を、実装後の契約に合わせる。自動移行を実装しない場合は「§9.2 の MUST を高レベル API では満たせない」制限を残し、代わりに低レベル API を使う必要がある旨を維持する
- 実リレーで GOAWAY を発生させる経路があれば E2E を追加する。無ければ確認した内容を解決方法に記録する
- `npx vp check` と `npx vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

{未着手}

## 参照

- `src/session/publicTypes.ts` の `ConnectCallbacks.goaway` / `SubscribeCallbacks.goaway`
- `src/createMedia/connect.ts` の `connectMediaSession` / `MediaConnectSettings`
- `src/createMediaSubscriber.ts` の `MediaSubscriberImpl.connectToServer` / `subscribeMediaTracks`
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.connectToServer`
- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe`
- `src/codec/types.ts` の `MediaSubscriberCallbacks` / `MediaPublisherCallbacks`
- `docs/HIGH_LEVEL_API.md` の「start() の失敗」の「GOAWAY の扱い」
- `tests/e2e/main.ts` の `window.__moqtE2E`
- draft-ietf-moq-transport-22 §9.2
