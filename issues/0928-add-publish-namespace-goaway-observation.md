# GOAWAY 後の PUBLISH_NAMESPACE の終了が高レベル API から観測できない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/add-publish-namespace-goaway-observation
- Polished: {YYYY-MM-DD}

## 目的

要求ストリームで GOAWAY を受信した後の RESET / FIN は、publication のリクエスト単位 `error` も `ConnectCallbacks.error` も通知せず、`NamespacePublication.state` が `"closed"` になるだけで終わる。`createMediaPublisher` の `announceNamespace` は低レベルの `goaway` コールバックを渡していないため、高レベル API は告知が閉じた理由 (GOAWAY による移行) を観測できず、再告知の判断もできない。draft-ietf-moq-transport-22 §9.2 は、要求ストリームの GOAWAY を受けた endpoint が新しい Session URI で要求を再発行し、旧ストリームを閉じる SHOULD を定める。

## 現状

- `src/session/namespaceLoops.ts` の `namespaceHandleGoaway` は `callbacks.goaway` を呼び、新しい Session URI を返す
- `namespaceHandleGoawayMessage` は確立後の GOAWAY で送信方向を FIN し、`goawayReceived` を立てて読み取りを継続する
- `createPublicationStreamHandlers` の `onReadError` は `!ctx.progress.goawayReceived` のときだけ通知するため、GOAWAY 後の読み取り失敗は通知しない
- `src/createMediaPublisher.ts` の `announceNamespace` は `NamespacePublicationCallbacks` に `error` だけを渡し、`goaway` を渡していない
- `src/codec/types.ts` の `MediaPublisherCallbacks` に goaway の通知が無い
- `docs/HIGH_LEVEL_API.md` には、要求ストリームで GOAWAY を受信した後の `RESET_STREAM` は通知しないと記載している
- `issues/0891-add-high-level-goaway-migration.md` は高レベル API の GOAWAY 移行 (再接続) を扱う。本 issue は publication の終了理由の観測に限定し、移行の設計判断は 0891 に委ねる

## 設計方針

高レベル API から GOAWAY による告知の終了を観測できるようにする。候補は次のとおり。

- `announceNamespace` が `NamespacePublicationCallbacks.goaway` を受け取り、`MediaPublisherCallbacks` の新しいコールバック (または `onError`) へ流す
- `NamespacePublication` に閉じた理由を持たせる (`state` が `"closed"` になった理由を `goaway` の URI として読めるようにする)

どちらを採るかは 0891 の設計と整合させる。`onError` に流す場合は、GOAWAY が失敗ではなく移行の通知であることを契約に明記する。

## 完了条件

- 高レベル API (`createMediaPublisher`) から、GOAWAY による告知の終了を観測できる
- 観測の手段を `docs/HIGH_LEVEL_API.md` と `src/session/publicTypes.ts` に記述する
- `src/createMediaPublisher.test.ts` と `src/session/namespaceLoops.test.ts` で固定する
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaceLoops.ts` の `namespaceHandleGoaway` / `namespaceHandleGoawayMessage` / `createPublicationStreamHandlers` の `onReadError`
- `src/createMediaPublisher.ts` の `announceNamespace` / `namespacePublication`
- `src/session/publicTypes.ts` の `NamespacePublicationCallbacks` / `NamespacePublication`
- `src/codec/types.ts` の `MediaPublisherCallbacks`
- `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」
- draft-ietf-moq-transport-22 §9.2
