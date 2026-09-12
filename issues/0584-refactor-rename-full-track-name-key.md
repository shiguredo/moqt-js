# getFullTrackName の戻り値が比較キーになったため名前を揃える

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-rename-full-track-name-key
- Polished: {YYYY-MM-DD}

## 目的

`SubscriberImpl.getFullTrackName` / `FetcherImpl.getFullTrackName` は、Track の同一性判定用に「Track Namespace Field と Track Name を長さ付きで連結した比較キー」を返すようになった。戻り値は Full Track Name そのものではないため、名前と実体が一致していない。将来この戻り値を表示・ログ・プロトコル上の Full Track Name として使う誤用を防ぐため、名前を実体に合わせる。

## 現状

- `src/subscriber.ts` の `SubscriberImpl.getFullTrackName` と `src/fetcher.ts` の `FetcherImpl.getFullTrackName` は、`src/fullTrackName.ts` の `fullTrackNameKey` が生成する比較キーを返す。
- JSDoc には「戻り値は fullTrackNameKey が生成する長さ付きキーであり、Full Track Name そのものではない」と明記しているが、名前は `getFullTrackName` のままである。
- 呼び出し側は `const trackKey = ...getFullTrackName()` のようにキーとして受け取っており、名前と実体のずれがコード上に露出している (`src/session/bidi.ts` の `cancelMalformedTrackPeers` / `bidiReadSubscribeResponse`、`src/session.ts` の `handleMalformedSubgroupTrack` / `handleMalformedFetchTrack` / `handleIncomingBidirectionalStream`、`src/session/incoming.ts` の `incomingHandleDatagram`)。
- `getFullTrackName` は公開インターフェース (`Subscriber` / `Fetcher`) には含まれず、`src/index.ts` からも再エクスポートされていないため、改名の影響はリポジトリ内に閉じる。

## 設計方針

1. `getFullTrackName` を `getFullTrackNameKey` に改名する (`SubscriberImpl` / `FetcherImpl` の双方)。
2. 全呼び出し元とテストの参照を改名に追随させる。
3. JSDoc は「比較キーを返す」ことを維持し、生成規則の正本が `fullTrackNameKey` であることを明記する。

## 完了条件

- `getFullTrackName` の参照がリポジトリ内に残っていないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- 既存の挙動 (cross-cancel / Track Alias 重複判定) が変わらないこと。

## 関連

- `src/fullTrackName.ts` / `src/subscriber.ts` / `src/fetcher.ts` / `src/session/bidi.ts` / `src/session.ts` / `src/session/incoming.ts`
- `issues/closed/0574-bug-full-track-name-collision.md` (Full Track Name の比較キーを導入した issue)
