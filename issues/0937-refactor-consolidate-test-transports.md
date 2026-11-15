# テストの transport ハーネス 4 種が重複している

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-consolidate-test-transports
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

`src/session.test.ts` に、双方向ストリームの transport を組み立てるハーネスが 4 種ある。readable / writable / `createBidirectionalStream` の構築が重複しており、新しいテストを書くときにどれを使うか迷う。0890 で `createHeldBidiStreamTransport` (当時の名前は `createHeldNamespaceTransport`。0934 で改名) に `holdCreate` / `failWrite` を足し、0934 で `failCreate` / `holdCancel` も足したため、他のハーネスの用途を `createHeldBidiStreamTransport` で表現できる範囲が広がった。統合して保守コストを下げる。

## 現状

- `createCountingBidirectionalStreamTransport` は `createBidirectionalStream` の呼び出し回数を数え、readable を即座に閉じる
- `createNamespaceSendFailureTransport` は write の失敗、readable の cancel、writer の abort / close を観測する
- `createPendingNamespaceTransport` は write を即座に解決し、ピア起点の close を再現する
- `createHeldBidiStreamTransport` は write の保留 / 失敗、ストリーム作成の保留 / 失敗、cancel の保留、cancel / abort の観測、`writeStarted` / `cancelStarted` の観測、ピア起点の close を再現する
- `createHeldBidiStreamTransport` の保留 / 失敗 / 観測の仕組みを一般化すれば、残り 3 種が持つ機能を表現できる。ただし現状は write を常に保留し、作成回数の計数、readable の即時 close、writer.close の観測を持たないため、そのままでは置き換えられない

## 設計方針

1 つの configurable な transport factory に統合する。

- オプション: `holdCreate` / `holdWrite` / `holdCancel` / `failCreate` / `failWrite` / `closeReadable` (counting 用) / `countCreatedStreams`
- 既定値: `holdCreate` / `holdWrite` / `holdCancel` は指定したときだけ保留する (既定 false)。`failCreate` / `failWrite` / `closeReadable` / `countCreatedStreams` も既定 false とする。既存の `createHeldBidiStreamTransport` の呼び出しは `holdWrite: true` を渡し、`createHeldRequestSession` / `createHeldNamespaceSubscriptionSession` は `createHeldBidiStreamTransport({ holdWrite: true, ...options })` のように `holdWrite: true` を既定として合成する
- 返り値: `transport` / `readable` / `writable` / `cancelled` / `aborted` / `closed` (writer.close の記録。transport の `closed` Promise とは別) / `getCreatedCount` / `writeStarted` / `isWriteStarted` / `cancelStarted` / `releaseCreate` / `releaseWrite` / `releaseCancel` / `closeFromPeer`
- 既存テストの呼び出しと、それを包む `createHeldRequestSession` / `createHeldNamespaceSubscriptionSession` を新しい factory に置き換える
- 名前は用途ではなく能力で表す (`createConfigurableBidiStreamTransport` など)

購読系のテストが `createNamespaceSendFailureTransport` の writer.close を観測している場合は、その観測口 (`closed`) を新しい factory に含める。1 ファイル内のテストヘルパーの整理なので、`src/session.test.ts` の範囲で完結させる。対象は上記 4 種のハーネスに限り、目的別に特化した単発のヘルパー (`createWriteFailureSession` / `createPublishSession` / `createEncodeFailureSession` / `createSubscribeFillContext` など) は統合しない。

## 完了条件

- 上記 4 種の transport ハーネスが 1 つに統合され、4 種がそれぞれ構築していた readable / writable / `createBidirectionalStream` の重複が無くなる
- 既存テストの期待値と検証内容を変えない
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。テストのみの変更のため `### misc` にも記載しない。

## 参照

- `src/session.test.ts` の `createCountingBidirectionalStreamTransport` / `createNamespaceSendFailureTransport` / `createPendingNamespaceTransport` / `createHeldBidiStreamTransport`
- `src/testSupport/bidi.ts` の `createTestBidirectionalStream` / `createTestWebTransport` (既存の共有ハーネス。今回の統合対象ではない)
- `src/session.test.ts` の `createHeldRequestSession` / `createHeldNamespaceSubscriptionSession`
