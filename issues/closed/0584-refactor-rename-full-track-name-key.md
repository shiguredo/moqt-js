# getFullTrackName の戻り値が比較キーになったため名前を揃える

- Created: 2026-09-12
- Completed: 2026-09-12
- Branch: feature/refactor-rename-full-track-name-key
- Polished: 2026-09-12

## 目的

`SubscriberImpl.getFullTrackName` / `FetcherImpl.getFullTrackName` は、Track の同一性判定用に「Track Namespace Field と Track Name を長さ付きで連結した比較キー」を返すようになった。戻り値は Full Track Name そのものではないため、名前と実体が一致していない。将来この戻り値を表示・ログ・プロトコル上の Full Track Name として使う誤用を防ぐため、名前を実体に合わせる。

## 現状

- `src/subscriber.ts` の `SubscriberImpl.getFullTrackName` と `src/fetcher.ts` の `FetcherImpl.getFullTrackName` は、`src/fullTrackName.ts` の `fullTrackNameKey` が生成する比較キーを返す。
- JSDoc には「戻り値は fullTrackNameKey が生成する長さ付きキーであり、Full Track Name そのものではない」と明記しているが、名前は `getFullTrackName` のままである。
- 呼び出し側は `const trackKey = ...getFullTrackName()` のようにキーとして受け取っており、名前と実体のずれがコード上に露出している。旧名を参照する箇所は次のとおり。
  - 定義: `src/subscriber.ts` の `SubscriberImpl` / `src/fetcher.ts` の `FetcherImpl`
  - 呼び出し: `src/session/bidi.ts` の `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `cancelMalformedTrackPeers`、`src/session.ts` の `handleIncomingBidirectionalStream` / `handleFillFetchStream` / `handleMalformedFetchTrack` / `handleMalformedSubgroupTrack`、`src/session/incoming.ts` の `incomingHandleDatagram`
  - テスト: `src/session/bidi.test.ts`
  - JSDoc / コメント: `src/session.ts` の `handleIncomingBidirectionalStream`、`src/session/bidi.ts` の `cancelMalformedTrackPeers`、`src/session.test.ts`、`src/fullTrackName.prop.ts`
- `getFullTrackName` は公開インターフェース (`Subscriber` / `Fetcher`) には含まれず、`src/index.ts` からも再エクスポートされていないため、改名の影響はリポジトリ内に閉じる (`docs/` / `examples/` / `tests/` / `devtools/` に参照は無い)。

## 設計方針

1. `getFullTrackName` を `getFullTrackNameKey` に改名する (`SubscriberImpl` / `FetcherImpl` の双方)。メソッド本体が呼ぶのは import した `fullTrackNameKey` であり、メソッド名とは字句スコープが異なるため衝突しない。
2. 定義・呼び出し元・テスト・JSDoc / コメントの旧名参照をすべて改名に追随させる。網羅は `rg -n "getFullTrackName\b" src` が 0 件になることで確認する (`getFullTrackNameKey` は旧名を接頭辞に含むため、`\b` を付けないと改名後のコード自身に一致する)。
3. JSDoc は「比較キーを返す」ことを維持し、生成規則の正本が `fullTrackNameKey` であることを明記する。
4. `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加する (機能に直接影響しないリファクタのため)。`## develop` 内の `### misc` は 2 箇所あり、直近の追記先は後方の `### misc` である。

## 完了条件

- `src/` 配下に旧名 (`getFullTrackName`) の参照が残っていないこと (`rg -n "getFullTrackName\b" src` が 0 件)。`issues/` 配下の issue は履歴であり、旧名の記述を書き換えない。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- 既存の挙動 (cross-cancel / Track Alias 重複判定) が変わらないこと。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` が追加されていること。

## 関連

- `src/fullTrackName.ts` / `src/subscriber.ts` / `src/fetcher.ts` / `src/session/bidi.ts` / `src/session.ts` / `src/session/incoming.ts`
- `issues/closed/0574-bug-full-track-name-collision.md` (Full Track Name の比較キーを導入した issue)

## 解決方法

`SubscriberImpl` / `FetcherImpl` の内部メソッド `getFullTrackName` を `getFullTrackNameKey` に改名し、名前と実体 (Full Track Name ではなく `fullTrackNameKey` が生成する比較キーを返す) を一致させた。挙動の変更はなく、公開 API への影響もない。

- `src/subscriber.ts` の `SubscriberImpl` と `src/fetcher.ts` の `FetcherImpl` のメソッドを `getFullTrackNameKey` に改名した (JSDoc は「比較キーを返す」「生成規則の正本は `fullTrackNameKey`」を維持)
- 呼び出し元を改名に追随させた (`src/session/bidi.ts` の `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `cancelMalformedTrackPeers`、`src/session.ts` の `handleIncomingBidirectionalStream` / `handleFillFetchStream` / `handleMalformedFetchTrack` / `handleMalformedSubgroupTrack`、`src/session/incoming.ts` の `incomingHandleDatagram`)
- テストとコメントの旧名参照を追随させた (`src/session/bidi.test.ts` / `src/session.test.ts` / `src/fullTrackName.prop.ts`)。`cancelMalformedTrackPeers` の JSDoc は、TRACK_STATUS 経路が session 側で生成した比較キーを渡すことも読み取れる記述に整えた
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
- 比較キーを生成する経路 (受信 PUBLISH の重複判定 / SUBSCRIBE_OK の重複判定 / malformed 検出時の cross-cancel 6 経路) がすべて `fullTrackNameKey` 由来のままであること、`rg -n "getFullTrackName\b" src` が 0 件であること、`vp check` / `tsc --noEmit` / `vp test run` (69 files / 1996 tests) が通ることを確認した
- 既存テストは無変更で通り、比較キーの期待値 (長さ付きキー) も変わっていない
