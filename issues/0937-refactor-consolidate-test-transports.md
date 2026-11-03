# テストの transport ハーネス 4 種が重複している

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-consolidate-test-transports
- Polished: {YYYY-MM-DD}

## 目的

`src/session.test.ts` に、双方向ストリームの transport を組み立てるハーネスが 4 種ある。readable / writable / `createBidirectionalStream` の構築が重複しており、新しいテストを書くときにどれを使うか迷う。0890 で `createHeldNamespaceTransport` に `holdCreate` / `failWrite` を足したため、他のハーネスで表現できる範囲が広がった。統合して保守コストを下げる。

## 現状

- `createCountingBidirectionalStreamTransport` は `createBidirectionalStream` の呼び出し回数を数え、readable を即座に閉じる
- `createNamespaceSendFailureTransport` は write の失敗、readable の cancel、writer の abort / close を観測する
- `createPendingNamespaceTransport` は write を即座に解決し、ピア起点の close を再現する
- `createHeldNamespaceTransport` は write の保留 / 失敗、ストリーム作成の保留、cancel / abort の観測、ピア起点の close を再現する
- `createHeldNamespaceTransport` のオプションで残り 3 種の大半を表現できる

## 設計方針

1 つの configurable な transport factory に統合する。

- オプション: `holdCreate` / `holdWrite` / `failWrite` / `closeReadable` (counting 用) / `countCreatedStreams`
- 観測口: `cancelled` / `aborted` / `closed` / `getCreatedCount` / `writeStarted` / `releaseCreate` / `releaseWrite` / `closeFromPeer`
- 既存テストの呼び出しを新しい factory に置き換える
- 名前は用途ではなく能力で表す (`createNamespaceTestTransport` など)

購読系のテストが `createNamespaceSendFailureTransport` の writer.close を観測している場合は、その観測口を新しい factory に含める。1 ファイル内のテストヘルパーの整理なので、`src/session.test.ts` の範囲で完結させる。

## 完了条件

- transport ハーネスが 1 つに統合され、重複する readable / writable / `createBidirectionalStream` の構築が無くなる
- 既存テストの期待値と検証内容を変えない
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。テストのみの変更のため `### misc` にも記載しない。

## 参照

- `src/session.test.ts` の `createCountingBidirectionalStreamTransport` / `createNamespaceSendFailureTransport` / `createPendingNamespaceTransport` / `createHeldNamespaceTransport`
- `src/testSupport/` 配下の既存ハーネス
