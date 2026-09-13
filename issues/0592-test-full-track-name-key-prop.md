# fullTrackNameKey の同一性 PBT が恒真で getFullTrackNameKey との一致を検証していない

- Created: 2026-09-12
- Completed: 2026-09-13
- Branch: feature/test-full-track-name-key-prop
- Polished: {YYYY-MM-DD}

## 目的

`src/fullTrackName.prop.ts` の「同じ Full Track Name は同じキーになる」テストは、JSDoc で「`getFullTrackNameKey` と受信 PUBLISH の比較キーが一致する前提を保証する」と主張しているが、本体は `fullTrackNameKey` を 2 回呼んで配列のコピーでも同じ結果になることしか見ていない。`fullTrackNameKey` は引数のみを読み配列を破壊しないためこの assert は構造的に失敗し得ず、検証内容が JSDoc の主張と一致していない。比較キーの生成経路 (メソッドと free 関数) が一致していることを実際に検証する。

## 現状

- `src/fullTrackName.prop.ts` の該当テストは `fullTrackNameKey(namespace, trackName)` と `fullTrackNameKey([...namespace], trackName)` の一致を assert している。
- `SubscriberImpl.getFullTrackNameKey()` / `FetcherImpl.getFullTrackNameKey()` の戻り値が `fullTrackNameKey` と一致することは、どのテストでも直接は検証されていない (`src/session/bidi.test.ts` の `cancelMalformedTrackPeers` のテストは戻り値をキーとして渡しているだけ)。
- 受信 PUBLISH の重複判定は `src/session.ts` の `handleIncomingBidirectionalStream` が `fullTrackNameKey` を直接呼ぶため、メソッド側の生成規則がずれても気付きにくい。

## 設計方針

1. 恒真な assert を、`SubscriberImpl` / `FetcherImpl` を実際に組み立てて `getFullTrackNameKey()` の戻り値が `fullTrackNameKey(namespace, trackName)` と一致することを検証する PBT に置き換える (モック・スタブは使わない)。
2. JSDoc を実際に検証する内容に合わせる。受信 PUBLISH 側が `fullTrackNameKey` を直接呼ぶことは、比較対象が同一の free 関数であることの説明として書く。
3. キー生成の形式 (長さ付き) を変えると落ちるテストであることを実装時に確認する。

## 完了条件

- 恒真な assert が無くなり、`getFullTrackNameKey()` と `fullTrackNameKey` の一致を検証していること。
- JSDoc の主張と検証内容が一致していること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加すること (テスト修正のため)。

## 関連

- `src/fullTrackName.prop.ts` / `src/fullTrackName.ts` / `SubscriberImpl` (`src/subscriber.ts`) / `FetcherImpl` (`src/fetcher.ts`)
- `issues/closed/0574-bug-full-track-name-collision.md` (比較キーと PBT を導入した issue)

## 解決方法

JSDoc の主張と実装を一致させた。比較キーの生成経路が一致することを実際に検証するテストを追加している。

- `src/fullTrackName.prop.ts` の「同じ Full Track Name は同じキーになる」テストの JSDoc から「getFullTrackNameKey と受信 PUBLISH の比較キーが一致する前提を保証する」を削除し、このテストが確かめる範囲 (配列の参照に依存せず、内容が同じ別配列から生成してもキーが一致すること) に限定した。生成経路の一致は別のテストで検証する旨を明記した。
- 比較キーの生成経路の一致を検証するテスト「getFullTrackNameKey は fullTrackNameKey と同じ比較キーを返す」を追加した。`fullTrackNameArb` で生成した Full Track Name について、`new SubscriberImpl(...).getFullTrackNameKey()` と `new FetcherImpl(...).getFullTrackNameKey()` が free 関数 `fullTrackNameKey(namespace, trackName)` と一致することを検証する。cross-cancel は各 Impl の `getFullTrackNameKey()` を、受信 PUBLISH の重複判定は free 関数を使うため、片方だけ形式が変わると同一 Track が不一致になり cross-cancel が空振りする。この回帰を検出できる。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した (0591 と同じエントリに含めた)。

## 検証

- 追加したテストは `new SubscriberImpl(namespace, trackName, 0n, 0n, () => {})` と `new FetcherImpl(namespace, trackName, 0n, () => {})` を生成して比較する。`subscriber.prop.ts` / `publisher.prop.ts` に Impl を直接生成する前例があり、新規ハーネスは不要だった。
- `pnpm test run`: 70 ファイル / 2,091 テスト全通過 (追加した 1 件を含む)。`src/fullTrackName.prop.ts` は 3 件から 4 件になった。
- `pnpm typecheck` / `pnpm lint` / `pnpm fmt` すべて成功
