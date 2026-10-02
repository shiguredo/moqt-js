# FETCH_OK の End Location が inclusive であることを明確化する

- Created: 2026-10-02
- Completed: 2026-10-03
- Branch: feature/update-fetch-ok-end-location-semantics
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 §9.12 は FETCH_OK の End Location を「The end of the range covered by the FETCH response, inclusive.」と明記した。v21 は "The end of the range covered by the FETCH response." とだけ書いており、inclusive であることが読み取りにくかった。End Location が対応する FETCH の Start Location より小さい場合は PROTOCOL_VIOLATION で、End == Start は有効 (1 つの Object だけを含む範囲) である。

moqt-js の検証とコメントが inclusive の解釈と一致することを確認し、テストで固定する。

## 現状

- `src/session/params.ts` の `validateFetchOkEndLocation` は `compareLocations(endLocation, startLocation) < 0` のときだけエラーを返し、End == Start を許容している。inclusive の解釈と整合する
- `src/fetcher.ts` の `endLocation` (Fetcher インターフェースのプロパティと `FetcherImpl` の getter) には JSDoc/コメントが無く、inclusive の意味が書かれていない
- `src/session/publicTypes.ts` の `FetchOptions.filter` のコメントに終了側の既定 (Largest Object) の説明がある
- コメントの参照は v21 §9.12

## 設計方針

- `Fetcher.endLocation` の JSDoc に「範囲の最後の Object を含む (inclusive)」ことと「End < Start は PROTOCOL_VIOLATION」であることを明記し、参照を v22 §3.2 / §9.12 に更新する
- `validateFetchOkEndLocation` のコメントに End == Start が有効であることを明記する
- `params.test.ts` / `src/session/params.prop.ts` の既存テストを確認し、End == Start を許容し End < Start を拒否するテストがあることを固定する

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

draft-ietf-moq-transport-22 §3.2 / §9.12 を正として、FETCH_OK の End Location が inclusive であることの解釈をコメントに記録し、テストで固定した。挙動の変更はない。

### 1. 確認結果

- `validateFetchOkEndLocation` は `compareLocations(endLocation, startLocation) < 0` のときだけエラーを返し、End == Start を許容している。inclusive の解釈と一致する
- 検証が行われるのは開始位置をクライアント側で確定できる FETCH だけである (相対指定 (0x01) / Next Object (0x05) は Largest Object 依存のため `resolveFetchStartLocation` が undefined を返し、検証をスキップする)。この前提もコメントに書いた
- End < Start のときは §9.12 の MUST により、FETCH_OK を受け取った側が PROTOCOL_VIOLATION でセッションを閉じる (`src/session/bidi.ts` の `bidiReadFetchResponse` が `validateFetchOkEndLocation` の戻り値を受けて `closeWithError` する)
- End を exclusive として扱っている箇所は無かった (`endLocation` の利用は `src/fetcher.ts` / `src/session/bidi.ts` / `src/message/fetch.ts` のみ)
- inclusive は「範囲の終端が範囲に含まれる」の意味であり、End と同じ Location の Object が必ず届くという配送の保証ではない (§3.2 は範囲内に Object が無い場合に FETCH_HEADER の後 FIN で閉じることを許す)。この区別もコメントに書いた

### 2. コメントの追加

- `Fetcher.endLocation` の JSDoc に §3.2 の "A FETCH requests pre-existing Objects from a Track between a Start Location and an End Location, inclusive."、End == Start が幅 1 の範囲として有効であること、End < Start のときの PROTOCOL_VIOLATION と閉じる主体を書いた
- `FetcherImpl` の `endLocation` getter にも同旨のコメントを付けた
- `validateFetchOkEndLocation` の JSDoc に §9.12 の逐語 2 つ (inclusive の定義と MUST) と、End == Start を許容し End < Start だけをエラーにすること、開始位置が確定できない場合に検証しないことを書いた
- 併せて `trackProperties` の FETCH_OK の参照を v22 §9.12 に更新した

### 3. テスト

- End == Start が有効であることを固定する単体テストを追加した (幅 1 の範囲)
- End < Start を拒否する単体テストと PBT (`src/session/params.prop.ts`) は既存のものを維持している

### 4. 検証

`vp check` (1284 files 整形 / 475 files lint・型エラーなし) / `tsc --noEmit` / `vp test run` (198 files / 3566 tests) が通る。`/review-diff-code` を 3 周回し、指摘 (セッションを閉じる主体、inclusive の配送保証の断定、§3.2 の参照漏れ、検証の前提条件、引用の省略記号) はすべて反映した。CHANGES.md の `## develop` の `### misc` に [UPDATE] エントリを追加した。なお issue の参照にあった `session.prop.ts` は `src/session/params.prop.ts` の誤りだったため直した。
