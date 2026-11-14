# LOCATION FILTER を省略した FETCH を relay が NOT_SUPPORTED で拒否する

- Created: 2026-10-01
- Completed: 2026-11-14
- Branch: feature/fix-fetch-without-location-filter
- Polished: 2026-11-14

## 目的

draft-ietf-moq-transport-23 §3.2 は、FETCH の Location Filter を省略した場合の範囲を `{0, 0}` から Largest Object までと定める。この形は仕様上有効であり、`buildFetchParameters` は Location Filter を載せず、`encodeFetchPayload` は空の Parameters を書く。

2026-10-01 に実リレーへ接続する E2E テストへこの形の FETCH を追加したところ、`session.fetch()` が解決せず、テストページの 30 秒の上限で打ち切られた。当時のリレーは draft-22 以前で、FETCH_OK 0x18 を使う実装であった。同じ track に対する絶対開始の Location Filter の FETCH は完了していた。

2026-11-14 に draft-23 対応のリレーへ接続して再観測し、relay が `{0, 0}` 起点の FETCH を REQUEST_ERROR の NOT_SUPPORTED で拒否することを確認した。本 issue はこの結果と catalog 取得への影響を記録して閉じる。

## 現状

- 送信側のワイヤは `buildFetchParameters` が Location Filter を載せず、`encodeFetchPayload` が空の Parameters を書く。0 個の Parameters を持つ FETCH の符号化は `src/message/fetch.prop.ts` のラウンドトリップと `src/message/fetch.test.ts` の固定バイト列で担保されている。ただし authorization token などを指定した場合は空にならない
- 受信側は `src/session/bidi.ts` の `bidiReadFetchResponse` が応答を読み、その経路が `src/session/requests.ts` で登録した `pendingFetch` を解決する
- 高レベル API の catalog FETCH は `src/createMediaSubscriber.ts` の `catalogFetchFilter` が、LARGEST_OBJECT が不明なときと Group 0 のときは絶対開始の `{ startGroup: 0n, startObject: 0n }` を返す。これは省略形と同じ範囲 `{0, 0}` から Largest Object までである
- publisher 側の object cache / FETCH 対応は open の 0948 で、通常の track の FETCH を NOT_SUPPORTED で拒否する実装である
- Location Filter Type 0x01 (相対開始) の FETCH は、draft-ietf-moq-transport-23 §3.2 が INVALID_RANGE と定めており、closed 0897 が送信前の拒否を実装済みである。本 issue の対象外である

## 解決方法

- 2026-11-14 に draft-23 対応のリレー (接続先は `TEST_MOQT_URI` で指定) で再観測した。同じ track に対する 0x02 の絶対開始 `{ startGroup: currentGroupId, startObject: 0 }` は 32 Object を受信して end が通知され、成功した
- 0x02 の `{ startGroup: 0, startObject: 0 }`、Location Filter を省略した FETCH、省略 + FILL TIMEOUT 0 は、いずれも約 40 ms で REQUEST_ERROR (reason phrase: "request type not supported") を返した。debug の受信種別は `send:FETCH` / `recv:REQUEST_ERROR` であり、無応答ではなかった
- これは relay が `{0, 0}` 起点の FETCH を NOT_SUPPORTED として拒否しているためであり、moqt-js の符号化・送信・受信経路の問題ではない。同じ実装の絶対開始 `{currentGroup, 0}` は成功している
- catalog 取得は、通常は `catalogFetchFilter` が `largestLocation.group` からの絶対開始を返すため影響しない。LARGEST_OBJECT が不明なときと Group 0 のときだけ `{0, 0}` を要求し、同じ REQUEST_ERROR になる。この範囲の取得は open の 0865 (catalog の fill fetch) と 0948 (publisher の FETCH 対応) で扱う
- `tests/e2e/relay/fetch.spec.ts` のコメントを、relay が無応答ではなく `{0, 0}` 起点の FETCH に REQUEST_ERROR を返す観測に更新した
- 相対の Location Filter は E2E に追加していない (送信前拒否は `src/session/params.test.ts` / `src/session/params.prop.ts` で固定済み)

## 参照

- draft-ietf-moq-transport-23 §3.2 (Fetch)、§3.2.1 (Fetch Object Delivery)、§3.2.3 (Relay Fetch Handling)、§9.3 (REQUEST_OK。FETCH_OK の別名)、§9.4 (REQUEST_ERROR。FETCH_ERROR の別名)、§9.19.5 (FILL TIMEOUT)、§9.19.9 (LOCATION FILTER)、§12.3 (エラーコード)
- `refs/moq/draft-ietf-moq-transport-23.txt`
- `src/session/params.ts` の `buildFetchParameters` / `resolveFetchRequestRange`
- `src/message/fetch.ts` の `encodeFetchPayload`、`src/message/fetch.prop.ts`、`src/message/fetch.test.ts`
- `src/session/bidi.ts` の `bidiReadFetchResponse` (応答の読み取りと `pendingFetch` の解決)、`src/session/requests.ts` の `pendingFetch` (待ちの登録)
- `src/createMediaSubscriber.ts` の `catalogFetchFilter`
- `tests/e2e/main.ts` の `startFetch`、`tests/e2e/relay/fetch.spec.ts`
- open の `issues/0865-change-catalog-fill-fetch.md` (catalog を fill fetch にする計画)、`issues/0948-add-publisher-object-cache-and-fetch.md` (publisher が FETCH を NOT_SUPPORTED で拒否する件)
- closed の `issues/closed/0897-moqt-draft-23-fetch-request-ok.md` (相対 Location Filter の送信前拒否)、`issues/closed/0443-test-add-e2e-fetch-coverage.md` (この issue の前身)、`issues/closed/0796-moqt-draft-22-location-filter-explicit-type.md` (Location Filter の符号化の変更)
- 2026-10-01 の観測: CI 実行 36797457622 / 36798049640 (後者は保持期限切れ)
