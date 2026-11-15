# onGoaway が GOAWAY の由来 (制御ストリーム / リクエストストリーム) を区別できない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-ongaway-source
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

高レベル API の `onGoaway(newSessionUri)` は新しい Session URI だけを渡すため、アプリは GOAWAY が Session の制御ストリーム由来 (セッション全体の移行) か、SUBSCRIBE / PUBLISH / PUBLISH_NAMESPACE / FETCH のリクエストストリーム由来 (そのリクエストだけの移行) かを区別できない。draft-ietf-moq-transport-23 §9.2 と §6.6.1 は両者を別の意味で定めており、アプリの対応 (インスタンス全体の作り直し / 特定のリクエストの再発行) が変わる。

本 issue は、高レベル API が GOAWAY の由来を区別しない契約を採ることを決め、その契約を docs と JSDoc に明記する。あわせて、直前と同じ URI の連続通知の抑止がこの契約で安全である理由を明記する。

## 現状

- `src/codec/types.ts` の `MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway` は `(newSessionUri: string) => void` であり、由来を受け取る引数が無い
- 0891 は通知のみを実装した (`issues/closed/0891-add-high-level-goaway-migration.md` の「解決方法」)。`docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」は「`onGoaway` は Session の制御ストリーム由来と、リクエストストリーム由来の両方で呼ばれ得る」と書いている
- 同節は、リクエストストリームの GOAWAY はそのリクエストだけが影響を受けることも書いている。一方、再接続の手順は、既存インスタンスを `stop()` / `close()` してから `onGoaway` の URI で作り直すことである。リクエストストリームの GOAWAY でもセッション全体を止める理由と、同一 URI の抑止がスコープをまたぐことを説明していない
- `src/createMediaSubscriber.ts` / `src/createMediaPublisher.ts` の `notifyGoaway` は `lastGoawayUri` と比較して直前と同じ URI の通知を捨てる。そのため、リクエストストリームの GOAWAY A の直後に制御ストリームの GOAWAY A が来ると、制御側 (セッション全体の移行) の通知が抑止される。この挙動は `src/createMediaSubscriber.lifecycle.test.ts` の「GOAWAY: onGoaway が Session と購読の GOAWAY の URI を受け取る」と `src/createMediaPublisher.test.ts` の「GOAWAY: onGoaway が Session と PUBLISH / PUBLISH_NAMESPACE の GOAWAY の URI を受け取る」で固定されている
- 高レベル API の `MediaSubscriber` / `MediaPublisher` は `start()` / `stop()` / `close()` で接続と購読 / 配信をまとめて扱い、単一リクエストの再発行 API を持たない (`src/codec/types.ts` の `MediaSubscriber` / `MediaPublisher`)。低レベル API は `ConnectCallbacks.goaway` / `SubscribeCallbacks.goaway` / `NamespacePublicationCallbacks.goaway` / `FetchCallbacks.goaway` / `PublishCallbacks.goaway` のように経路ごとにコールバックが分かれており、由来を区別できる

## 設計方針

案 A / B / C を比較し、案 C を採る。

- 案 A: `onGoaway` の引数に `source` と `request` を足す
- 案 B: `onSessionGoaway` と `onRequestGoaway` に分ける
- 案 C: 通知は URI だけのまま、高レベル API は GOAWAY の由来を区別しない契約を docs と JSDoc に明記する

案 C を採る理由:

- 高レベル API に単一リクエストの再発行 API が無いため、案 A / B で `source` を渡しても、アプリは特定のリクエストだけを再発行できない。`source` の実益は診断やログに限られ、アプリの対応は結局インスタンス全体の作り直しになる
- 案 C は公開 API の signature を変えないため、既存の利用者への影響が無い
- 将来、単一リクエストの再発行 API を追加するときに `source` を足す余地を JSDoc に残す

案 C の契約:

- 高レベル API は GOAWAY の由来を区別しない。すべての GOAWAY をセッション全体の再接続として扱う
- リクエストストリームの GOAWAY は、プロトコル上はそのリクエストだけが影響を受ける (draft-ietf-moq-transport-23 §9.2 / §6.6.1)。しかし高レベル API は単一リクエストの再発行 API を持たないため、アプリはセッション全体を再接続する。他の購読 / 配信も張り直すことになる
- 直前と同じ URI の連続通知の抑止は、この契約では安全である。リクエストストリームの GOAWAY A の直後に制御ストリームの GOAWAY A が来ても、アプリは最初の通知で A へセッション全体を再接続するため、2 回目の通知は同じ再接続を重ねるだけであり不要である
- この契約は `docs/HIGH_LEVEL_API.md` と `src/codec/types.ts` の `onGoaway` の JSDoc を正本とする

## 変更対象

- `docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」: 案 C の契約、リクエストストリームの GOAWAY でもセッション全体を再接続する理由、同一 URI の抑止が安全である理由を明記する。既存の「リクエストストリームの GOAWAY はそのリクエストだけが影響を受け (移行はアプリが行う)」という記述は、プロトコル上の効果と高レベル API の対応を区別して書き直す
- `src/codec/types.ts` の `MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway` の JSDoc: 案 C の契約を書き、将来 `source` を追加する可能性を残す
- `src/createMedia/connect.ts` の `MediaConnectSettings.onSessionGoaway` の JSDoc: 案 C の契約に合わせる
- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscriptionDependencies.reportGoaway` の JSDoc: SUBSCRIBE と FETCH の両方から呼ばれ、由来を区別しないことを書く
- `src/createMediaSubscriber.ts` / `src/createMediaPublisher.ts` の `notifyGoaway` の JSDoc: 抑止が URI だけで行われ、案 C の契約では安全であることを書く
- `src/createMediaSubscriber.lifecycle.test.ts` / `src/createMediaPublisher.test.ts` の GOAWAY テスト: 案 C は挙動を変えないため、新しいテストは不要。既存のテストが挙動を固定している
- `CHANGES.md`: MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。案 C は公開 API を変えないため、`### misc` の議論は不要

## 完了条件

- `docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」に、高レベル API は由来を区別しないこと、すべての GOAWAY をセッション全体の再接続として扱うこと、リクエストストリームの GOAWAY はプロトコル上はそのリクエストだけが影響を受けるがアプリはセッション全体を再接続すること、同一 URI の抑止がこの契約で安全であることが明記されている
- `src/codec/types.ts` の `MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway` の JSDoc に同じ契約が明記され、将来 `source` を追加する可能性が残されている
- 上記の内部 JSDoc (`onSessionGoaway` / `reportGoaway` / `notifyGoaway`) が契約と矛盾しない
- 既存のテストが、Session の制御ストリームとリクエストストリームの両方で `onGoaway` が呼ばれ、直前と同じ URI の連続通知が抑止されることを固定している。案 C は挙動を変えないため、新しいテストは不要である
- `vp check` と `vp test --run` が通る

## 参照

- `src/codec/types.ts` の `MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway` / `MediaSubscriber` / `MediaPublisher`
- `src/createMediaSubscriber.ts` / `src/createMediaPublisher.ts` の `notifyGoaway` / `lastGoawayUri` / `connectToServer`
- `src/createMedia/connect.ts` の `MediaConnectSettings.onSessionGoaway` / `connectMediaSession`
- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscriptionDependencies.reportGoaway`
- `src/createMediaSubscriber.ts` の `subscribeMediaTracks` / `src/createMediaPublisher.ts` の `announceNamespace` / `createPublishers`
- `src/session/publicTypes.ts` の `ConnectCallbacks.goaway` / `SubscribeCallbacks.goaway` / `NamespacePublicationCallbacks.goaway` / `FetchCallbacks.goaway` / `PublishCallbacks.goaway`
- `docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」
- `src/createMediaSubscriber.lifecycle.test.ts` の「GOAWAY: onGoaway が Session と購読の GOAWAY の URI を受け取る」
- `src/createMediaPublisher.test.ts` の「GOAWAY: onGoaway が Session と PUBLISH / PUBLISH_NAMESPACE の GOAWAY の URI を受け取る」
- draft-ietf-moq-transport-23 §9.2 / §6.6.1
- `issues/closed/0891-add-high-level-goaway-migration.md` (通知のみの決定)
- `issues/0928-add-publish-namespace-goaway-observation.md` (publication 単位の `goawayUri`。由来の区別は本 issue に委ねる)
- `issues/0942-refactor-goaway-notifier.md` (notifyGoaway の重複解消。案 C は signature を変えない)
- `issues/0944-fix-goaway-notify-state-guard.md` (close 後・旧世代の通知抑止。本 issue の契約と独立)
