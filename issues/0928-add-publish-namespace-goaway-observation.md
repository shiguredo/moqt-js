# PUBLISH_NAMESPACE の要求ストリームの GOAWAY による終了理由が高レベル API から観測できない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/add-publish-namespace-goaway-observation
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

要求ストリームで GOAWAY を受信した後の RESET / FIN は、publication のリクエスト単位 `error` も `ConnectCallbacks.error` も通知せず、`NamespacePublication.state` が `"closed"` になるだけで終わる。`createMediaPublisher` の `announceNamespace` は `NamespacePublicationCallbacks.goaway` を `onGoaway` へ流すが、`onGoaway` は新しい Session URI を渡すだけで、どの publication が GOAWAY で終了したかを示さない。そのため高レベル API は告知が閉じた理由 (GOAWAY による移行) を publication 単位で観測できず、再告知の判断もできない。draft-ietf-moq-transport-23 §9.2 は、要求ストリームの GOAWAY を受けた endpoint が新しい Session URI で要求を再発行し、旧ストリームを閉じる SHOULD を定める。

## 現状

- `src/session/namespaceLoops.ts` の `namespaceHandleGoaway` は `callbacks.goaway` を呼び、新しい Session URI を返す
- `namespaceHandleGoawayMessage` は確立後の GOAWAY で送信方向を FIN し、呼び出し元の `namespaceHandleGoawayStep` が `goawayReceived` を立てて読み取りを継続する
- `createPublicationStreamHandlers` の `onReadError` は `!ctx.progress.goawayReceived` のときだけ通知するため、GOAWAY 後の読み取り失敗は通知しない
- `src/createMediaPublisher.ts` の `announceNamespace` は 0891 で `NamespacePublicationCallbacks.goaway` を渡すようになり、`MediaPublisherCallbacks.onGoaway` へ流れる
- ただし `onGoaway` は新しい Session URI を渡すだけで、どの publication が GOAWAY で終了したかを示さない。publication の `state` が `"closed"` になること自体は観測できるが、その理由は観測できない
- `docs/HIGH_LEVEL_API.md` には、要求ストリームで GOAWAY を受信した後の `RESET_STREAM` は通知しないと記載している
- `issues/closed/0891-add-high-level-goaway-migration.md` は高レベル API の GOAWAY 移行 (再接続) を通知のみと決定済みである。本 issue は publication の終了理由の観測に限定し、移行の設計判断は扱わない

## 設計方針

高レベル API から GOAWAY による告知の終了理由を publication 単位で観測できるようにする。0891 で `onGoaway` の通知は入ったため、残るのは publication の終了理由の観測である。

本 issue では、`NamespacePublication` に GOAWAY の理由を持たせる案を採る。もう一方の `MediaPublisherCallbacks.onGoaway` を `(newSessionUri, options)` に広げる案は、subscriber と共有する `onGoaway` の signature を変えるため、open の `issues/0943-change-ongaway-source.md` (GOAWAY の由来) と調整が必要であり、本 issue の範囲を超える。`NamespacePublication` に閉じる案は publication のハンドルだけで完結し、subscriber 側の API と 0943 に影響しない。

- `NamespacePublication` に `readonly goawayUri: string | null` を足す。PUBLISH_NAMESPACE の要求ストリームで GOAWAY を受信したときの新しい Session URI を返す。新しい Session URI が 0 バイトのときは空文字列を返し、PUBLISH_NAMESPACE の要求ストリームで GOAWAY を受信していないときは null を返す (空文字列と null を区別する)
- `goawayUri` は PUBLISH_NAMESPACE の要求ストリームで GOAWAY を受信した時点で記録する。`NamespacePublicationCallbacks.goaway` を呼ぶ前に記録するため、`onGoaway` の中から `namespacePublication` を読んで観測できる (`start()` の実行中は `namespacePublication` が null のため、`start()` の完了後に読む)
- `onGoaway` の抑止 (直前と同じ URI の連続通知) があっても `goawayUri` は記録する。抑止は高レベル API の通知だけに適用され、低レベルの理由の記録には影響しない
- 内部状態 (`NamespacePublicationState`) に `goawayUri` を保持し、`NamespacePublication` は生成時にその内部状態への参照を保持する。ストリームの終了で `namespacePublications` から削除された後も `goawayUri` を読めるようにする
- `NamespacePublication.state` は GOAWAY では `"closed"` にしない。2 通目 GOAWAY の検出のため読み取りを継続する既存の挙動を変えず、state はストリームの終了後に `"closed"` になる。`goawayUri` は state が `"closed"` になる前でも後でも読める
- `MediaPublisherCallbacks.onGoaway` の signature は変えない。GOAWAY の由来の区別は 0943 に委ねる
- 本 issue では `onError` に流さない (GOAWAY は失敗ではなく移行の通知であるため)

## 完了条件

- 高レベル API (`createMediaPublisher`) で `announceNamespace: true` を指定して告知した場合、`namespacePublication.goawayUri` から、告知の確立後 (`start()` の完了後) に PUBLISH_NAMESPACE の要求ストリームで受けた GOAWAY による終了理由を publication 単位で観測できる。GOAWAY の新しい Session URI が 0 バイトのときは空文字列、PUBLISH_NAMESPACE の要求ストリームで GOAWAY を受信していないときは null を返す
- `goawayUri` は PUBLISH_NAMESPACE の要求ストリームで GOAWAY を受信した時点で設定され、`onGoaway` の呼び出し前と、ストリームの終了後に読める。`onGoaway` が抑止された場合でも設定される
- `NamespacePublication.state` は GOAWAY では `"closed"` にせず、ストリームの終了まで `"active"` のままである既存の挙動を変えない (2 通目 GOAWAY の検出のため)
- 観測の手段を `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」と「GOAWAY の扱い」、`docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」、`src/session/publicTypes.ts` の `NamespacePublication` の JSDoc、`src/codec/types.ts` の `MediaPublisherCallbacks.onGoaway` の JSDoc に記述する
- `MediaPublisherCallbacks.onGoaway` の signature は変えない
- `src/createMediaPublisher.test.ts` と `src/session/namespaceLoops.test.ts` で、GOAWAY 受信時に `goawayUri` が記録され、`onGoaway` から読めること、`onGoaway` が抑止されても記録されること、PUBLISH の GOAWAY と Session の制御ストリームの GOAWAY では設定されないこと、GOAWAY を受信していない RESET / FIN では null のままであること、`state` の既存の閉じ方を固定する
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaceLoops.ts` の `namespaceHandleGoaway` / `namespaceHandleGoawayMessage` / `namespaceHandleGoawayStep` / `createPublicationStreamHandlers` の `onReadError`
- `src/session/namespaces.ts` の `namespacesCreateNamespacePublication` / `namespacesCloseNamespacePublication`
- `src/session/types.ts` の `NamespacePublicationState`
- `src/createMediaPublisher.ts` の `announceNamespace` / `namespacePublication`
- `src/session/publicTypes.ts` の `NamespacePublicationCallbacks` / `NamespacePublication`
- `src/codec/types.ts` の `MediaPublisherCallbacks`
- `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」
- `src/createMediaPublisher.test.ts` の `namespacePublication` ハーネスと GOAWAY のテスト
- `src/session/namespaceLoops.test.ts` の `createNamespaceLoopTestContext` と publication ループの GOAWAY テスト
- draft-ietf-moq-transport-23 §9.2
- `issues/closed/0891-add-high-level-goaway-migration.md` (onGoaway の通知のみを決定済み)
- `issues/0943-change-ongaway-source.md` (onGoaway の由来。signature の変更は本 issue では行わない)
- `issues/0930-refactor-subscription-error-notification.md` (同じ `src/session/namespaceLoops.ts` / `src/session/namespaceLoops.test.ts` を変更する。着手順に注意する)
- `issues/0938-update-publish-namespace-goaway-during-send.md` (同じ `src/session/namespaces.ts` の送信経路を変更する。本 issue の作成経路とは関数が異なる)
