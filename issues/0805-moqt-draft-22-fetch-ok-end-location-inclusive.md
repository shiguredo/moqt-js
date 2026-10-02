# FETCH_OK の End Location が inclusive であることを明確化する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/update-fetch-ok-end-location-semantics
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §9.12 は FETCH_OK の End Location を「The end of the range covered by the FETCH response, inclusive.」と明記した。v21 は "The end of the range covered by the FETCH response." とだけ書いており、inclusive であることが読み取りにくかった。End Location が対応する FETCH の Start Location より小さい場合は PROTOCOL_VIOLATION で、End == Start は有効 (1 つの Object だけを含む範囲) である。

moqt-js の検証とコメントが inclusive の解釈と一致することを確認し、テストで固定する。

## 現状

- `src/session/params.ts` の `validateFetchOkEndLocation` は `compareLocations(endLocation, startLocation) < 0` のときだけエラーを返し、End == Start を許容している。inclusive の解釈と整合する
- `src/fetcher.ts` の `endLocation` の JSDoc/コメントは「FETCH_OK で受信した値」以上の説明が無く、inclusive の意味が書かれていない
- `src/session/publicTypes.ts` の `FetchOptions.filter` のコメントに終了側の既定 (Largest Object) の説明がある
- コメントの参照は v21 §9.12

## 設計方針

- `Fetcher.endLocation` の JSDoc に「範囲の最後の Object を含む (inclusive)」ことと「End < Start は PROTOCOL_VIOLATION」であることを明記し、参照を v22 §3.2 / §9.12 に更新する
- `validateFetchOkEndLocation` のコメントに End == Start が有効であることを明記する
- `params.test.ts` / `session.prop.ts` の既存テストを確認し、End == Start を許容し End < Start を拒否するテストがあることを固定する

## 完了条件

- `endLocation` と `validateFetchOkEndLocation` のコメントが inclusive の意味を説明している
- End == Start が有効であることと End < Start が拒否されることがテストで固定されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §3.2 (Fetch) / §9.12 (FETCH_OK)
- `src/fetcher.ts` の `endLocation` / `setFetchOkInfo`
- `src/session/params.ts` の `validateFetchOkEndLocation` / `compareLocations` / `resolveFetchStartLocation`
- `src/session/bidi.ts` の `bidiReadFetchResponse`

## 解決方法

{未着手}
