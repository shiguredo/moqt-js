# malformed track 検出時に同一 Track の購読と FETCH を相互に cancel する

- Created: 2026-09-09
- Completed: YYYY-MM-DD
- Branch: feature/fix-malformed-track-cross-cancel
- Polished: 2026-09-09

## 目的

draft-ietf-moq-transport-20 §2.4.2 は「it MUST cancel any corresponding subscription or fetches for that Track from that publisher」と定める。現状は購読の malformed 検出で当該購読のみ、FETCH の malformed 検出で当該 FETCH のみを cancel し、同一 Track の他方（FETCH / 購読）を cancel しない。

## 現状

- `src/session.ts` の `handleMalformedSubgroupTrack` は当該 alias の購読を cancel するが、同一 Track の FETCH は cancel しない。
- `src/session.ts` の `handleMalformedFetchTrack` は当該 FETCH を cancel するが、同一 Track の購読と他 FETCH は cancel しない（関数コメントに「対象は該当 requestId の FETCH のみとする」と明記されており、§2.4.2 の「fetches」が複数形であることとの乖離がある）。
- `src/session/incoming.ts` の `incomingHandleDatagram` の malformed 分岐は購読のみを cancel する。
- `src/session.ts` の `handleFillFetchStream` は malformed 検出で fill データストリームを打ち切るのみで、購読・FETCH は cancel しない（現行コメントは §5.1.3.1 を根拠に購読へ波及させない判断。§2.4.2 との関係は設計方針 3 参照）。

## 設計方針

1. malformed track 検出時、同一 Track に紐づく全購読と全 FETCH を cancel する。
2. 同一 Track の判定は Full Track Name（trackNamespace + trackName）で行う。FETCH データストリームのヘッダ（FetchHeader）と FETCH_OK は trackAlias を含まず、fetcher は Full Track Name しか持てないため、trackAlias では判定できない。subgroup / datagram 検出は trackAlias から `subscribersByAlias` で購読を特定し、その namespace / trackName で Full Track Name を得る。
3. subgroup / datagram / fetch / fill の各検出経路を同じ cancel 経路に接続する。fill は §5.1.3.1 の「resetting or cancelling a fill fetch stream... does not affect the subscription」が対象とする通常の失敗（reset / STOP_SENDING）とは別であり、malformed track の検出は §2.4.2 が優先して当該 Track の全購読と全 FETCH を cancel する。

## 完了条件

- malformed track 検出で同一 Track の全購読と全 FETCH が cancel されること（subgroup / datagram / fetch / fill の各検出経路）。
- 検出経路ごとに、購読と FETCH を混在させた cancel を検証するテストがあること。
- セッションは INTERNAL_ERROR で閉じないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §2.4.2 / §2.5.1 / §5.1.3.1
- `handleMalformedSubgroupTrack` / `handleMalformedFetchTrack` / `handleFillFetchStream`（`src/session.ts`）
- `incomingHandleDatagram`（`src/session/incoming.ts`）
- `bidiCancelSubscriptionWithError` / `bidiCancelFetch`（`src/session/bidi.ts`）
- `subscribersByAlias` / `subscribers` / `fetchers`（`src/session.ts`、Full Track Name で購読・FETCH を引く対象）
