# LOCATION FILTER を省略した FETCH に relay が応答しない

- Created: 2026-10-01
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-fetch-without-location-filter
- Polished: 2026-11-14

## 目的

draft-ietf-moq-transport-23 §3.2 は、FETCH の Location Filter を省略した場合の範囲を `{0, 0}` から Largest Object までと定める。この形は仕様上有効であり、`buildFetchParameters` は Location Filter を載せず、`encodeFetchPayload` は空の Parameters を書く。

2026-10-01 に実リレーへ接続する E2E テストへこの形の FETCH を追加したところ、`session.fetch()` が解決せず、テストページの 30 秒の上限で打ち切られた。同じ track に対する絶対開始の Location Filter の FETCH は完了していた。当時の観測は draft-22 以前のリレーと符号化 (FETCH_OK 0x18) によるものであり、現行の draft-23 と送受信の実装では再観測していない。

本 issue は、draft-23 のリレーに対して省略形の FETCH が何を返すかを特定し、ライブラリ側の問題なら受信経路を直し、リレー側の問題ならその事実と catalog 取得への影響を記録する。

### 対象外

- Location Filter Type 0x01 (相対開始) の FETCH。draft-ietf-moq-transport-23 §3.2 は相対の Location Filter を INVALID_RANGE と定め、closed 0897 が送信前の拒否を実装済みである (`src/session/params.ts` の `resolveFetchRequestRange`)。E2E に追加すると送信前に `InvalidFilterError` になるため、本 issue では扱わない
- 0x02 の絶対開始の一般化。本 issue では省略形の観測と、対照としての 0x02 `{0, 0}`、既存の成功対照に限定する
- fill fetch への切り替え (open の 0865) と、publisher の object cache / FETCH 対応 (open の 0948) の設計

## 現状

- 省略形の観測は 2026-10-01 の E2E で、当時のリレーは draft-22 以前であった。成功した絶対開始の対照は FETCH_OK 0x18 で応答し、省略形は応答が返らなかった。現行のリレー E2E は draft-23 対応リレーが無いため `TEST_MOQT_URI` 未設定でスキップされる (`.github/workflows/e2e-test.yml`、pending の 0817)。そのため現行 draft-23 での省略形の挙動は未確認である
- 当時の失敗は `tests/e2e/relay/fetch.spec.ts` の 30 秒の上限 (テストページの `startFetch`) による。CI の失敗実行は 36797457622 と 36798049640 で、後者はすでに保持期限を過ぎて参照できない
- 同じ track に対する絶対開始 (`{ startGroup: currentGroupId, startObject: 0n }`) の FETCH は当時 5.3 秒で成功した (pending の 0817 に記録。テスト全体の所要時間)。現行の draft-23 リレーでは未確認である。省略形と同じ `{0, 0}` 起点の絶対開始 (0x02) は対照として実行していない
- FILL TIMEOUT 0 を指定した FETCH も当時試したが、これは 0 個の Parameters ではなく 1 個 (FILL TIMEOUT) の Parameters であり、省略形とは別のワイヤである。結果は「応答しない」とだけ記録されており、エラーコードや所要時間は残っていない
- 送信側のワイヤは `buildFetchParameters` が Location Filter を載せず、`encodeFetchPayload` が空の Parameters を書く。0 個の Parameters を持つ FETCH の符号化は `src/message/fetch.prop.ts` のラウンドトリップと `src/message/fetch.test.ts` の固定バイト列で担保されている。ただし authorization token などを指定した場合は空にならない
- 受信側は `src/session/bidi.ts` の `bidiReadFetchResponse` が応答を読み、その経路が `src/session/requests.ts` で登録した `pendingFetch` を解決する。FETCH_OK が届いているのに解決しない場合はこの経路を調べる
- 高レベル API の catalog FETCH は `src/createMediaSubscriber.ts` の `catalogFetchFilter` が、LARGEST_OBJECT が不明なときと Group 0 のときは絶対開始の `{ startGroup: 0n, startObject: 0n }` を返す。これは省略形と同じ範囲 `{0, 0}` から Largest Object までであり、catalog 取得も同じ「range が relay の object cache で覆えない」「上流の fill を待つ」問題の影響を受け得る。`createMediaSubscriber.ts` のコメントも、その範囲が cache で覆えない場合に上流が FETCH に応答しないと catalog を取得できないと述べている
- publisher 側の object cache / FETCH 対応は open の 0948 で、通常の track の FETCH を NOT_SUPPORTED で拒否する実装である。上流 publisher が FETCH に応答しない構成では、relay が fill を待って FETCH_OK を返さない可能性がある
- 2026-10-01 の観測は Location Filter の符号化が現行と変わる前 (closed 0796) のものであり、当時の相対指定は明示的な Type 0x01 ではなく 1 フィールド形式であった。現在の観測をそのまま前提にしない

## 設計方針

### 前提

- draft-23 対応のリレーを用意できること。CI の relay E2E は現状スキップされるため、用意できない場合は本 issue を pending に移す (完了条件に含める)
- 省略形の範囲は `{0, 0}` から Largest Object までであり、0x02 の `{ startGroup: 0n, startObject: 0n }` と同じ範囲である。この 2 つを対照にして、フィルタ形式の違いと範囲・cache・fill の違いを切り分ける
- 相対の Location Filter は draft-23 で INVALID_RANGE であり、送信前に拒否される。E2E の対象にしない

### 手順

1. `tests/e2e/main.ts` の `startFetch` に `ConnectCallbacks.debug` を配線し、受信したメッセージの `typeName` と request ID、エラーコード、所要時間を `FetchObservation` に記録してテストログに出す。受信 debug は decoded を渡さないため、送信時の request ID を控えるか、`emitDebug` に decoded を渡す変更も必要になる。`tests/e2e/relay/fetch.spec.ts` のコメントに、観測時点のリレーの draft と結果を残す
2. draft-23 のリレーに対して次を実行し、結果を比べる。
   - 絶対開始 `{ startGroup: 0n, startObject: 0n }` (省略形と同じ範囲の対照)
   - 絶対開始 `{ startGroup: currentGroupId, startObject: 0n }` (既存の成功する対照)
   - Location Filter を省略した FETCH
   - 省略形 + FILL TIMEOUT 0 (1 個の Parameters)
3. 結果で分岐する。
   - FETCH_OK (REQUEST_OK) が届き、`session.fetch()` も解決する: relay は対応している。省略形の E2E テストを追加し、この issue を閉じる
   - FETCH_OK が届くが `session.fetch()` が解決しない: moqt-js の受信経路の問題として `bidiReadFetchResponse` / `pendingFetch` / FETCH_OK の終端解決を調べ、修正する。unit test と e2e テストを追加する
   - REQUEST_ERROR が返る: エラーコードと draft-23 §9.4 (REQUEST_ERROR) / §12.3 (エラーコード) の整合を確認する。FETCH_ERROR は仕様上の別名であり、debug の `typeName` は `REQUEST_ERROR` になる。relay が未対応なら relay 側の問題として記録し、catalog の `catalogFetchFilter` が同じ範囲を要求することによる影響を評価する
   - 無応答: relay 側の問題として記録する。上流 publisher が FETCH に対応しない (0948) ことによる fill 待ちも候補であり、省略形に限らない範囲・cache の問題として切り分ける
4. CI を赤くしない。relay が未対応の間は、省略形のテストを env ゲートの `test.skip` にするか、`fetch.spec.ts` にコメントとして観測結果を残す。既存の `TEST_MOQT_URI` はリレーの有無だけを表すため、「リレーは居るが省略形に未対応」を区別する env (例: `TEST_MOQT_FETCH_FILTER=1`) か実行時 skip を設計する。対応が確認できた時点で `test.skip` を外す。相対のテストは追加しない (送信前拒否の unit test が既にある)
5. 結果 (受信したメッセージの種別・所要時間・relay の draft、エラー時はエラーコード、無応答時はその旨) は、この issue の「解決方法」または `tests/e2e/relay/fetch.spec.ts` のコメントに残す。CI のログだけを根拠にしない

## 完了条件

- draft-23 対応リレーでの再観測結果 (メッセージ種別・所要時間・relay の draft、エラー時はエラーコード、無応答時はその旨) が issue に記録されている
- 原因が moqt-js 側なら、受信経路が修正され、unit test と `tests/e2e/relay/fetch.spec.ts` の省略形のテストが追加されている。relay が未対応の間はテストを `test.skip` にし、外す条件をコメントに書く
- 原因が relay 側なら、その事実と、`catalogFetchFilter` が LARGEST_OBJECT 不明時と Group 0 のときに同じ `{0, 0}` 範囲を要求することを issue に記録している。relay が外部で moqt-js 側の変更が不要なら結果を記録して closed (relay 側) とし、範囲・上流 fill の課題は 0865 / 0948 に引き継ぐ。リポジトリ内の publisher が原因なら 0948 で修正する
- draft-23 対応リレーを用意できない場合は、その blocker を記録して pending に移す
- 相対の Location Filter は E2E に追加していないこと (送信前拒否は既存の `src/session/params.test.ts` / `src/session/params.prop.ts` で固定済み)
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること (コードを変更した場合)

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- draft-ietf-moq-transport-23 §3.2 (Fetch)、§3.2.1 (Fetch Object Delivery)、§3.2.3 (Relay Fetch Handling)、§9.3 (REQUEST_OK。FETCH_OK の別名)、§9.4 (REQUEST_ERROR。FETCH_ERROR の別名)、§9.19.5 (FILL TIMEOUT)、§9.19.9 (LOCATION FILTER)、§12.3 (エラーコード)
- `refs/moq/draft-ietf-moq-transport-23.txt`
- `src/session/params.ts` の `buildFetchParameters` / `resolveFetchRequestRange`
- `src/message/fetch.ts` の `encodeFetchPayload`、`src/message/fetch.prop.ts`、`src/message/fetch.test.ts`
- `src/session/bidi.ts` の `bidiReadFetchResponse` (応答の読み取りと `pendingFetch` の解決)、`src/session/requests.ts` の `pendingFetch` (待ちの登録)
- `src/createMediaSubscriber.ts` の `catalogFetchFilter`
- `tests/e2e/main.ts` の `startFetch`、`tests/e2e/relay/fetch.spec.ts`、`.github/workflows/e2e-test.yml`
- pending の `issues/pending/0817-add-relay-tests.md` (draft-23 リレーが無く relay E2E をスキップしている件)、`issues/0865-change-catalog-fill-fetch.md` (catalog を fill fetch にする計画)、`issues/0948-add-publisher-object-cache-and-fetch.md` (publisher が FETCH を NOT_SUPPORTED で拒否する件)、`issues/0835-bug-catalog-fetch-cancel.md` / `issues/0837-test-catalog-drain-e2e.md`
- closed の `issues/closed/0897-moqt-draft-23-fetch-request-ok.md` (相対 Location Filter の送信前拒否)、`issues/closed/0443-test-add-e2e-fetch-coverage.md` (この issue の前身)、`issues/closed/0796-moqt-draft-22-location-filter-explicit-type.md` (Location Filter の符号化の変更)
- 2026-10-01 の観測: CI 実行 36797457622 / 36798049640 (後者は保持期限切れ)、当時の絶対開始の成功は 5.3 秒で pending の 0817 に記録

## 着手前の確認

- draft-23 対応リレーが無い場合は pending に移す。CI の relay E2E は現状スキップされている
- 相対の Location Filter は draft-23 で INVALID_RANGE であり、送信前に拒否される。本 issue の対象外である
- 省略形 (0 個の Parameters) と FILL TIMEOUT 0 (1 個の Parameters) は別のワイヤである。結果を混ぜて記録しない
- 省略形の範囲は 0x02 の `{0, 0}` と同じである。フィルタ形式の違いと、cache 未覆い・上流 fill 待ちの違いを必ず対照で切り分ける

## pending にした理由

draft-23 対応のリレーが無く、省略形の FETCH を再観測できない。`.github/workflows/e2e-test.yml` は `TEST_MOQT_URI` 未設定で relay project をスキップし、pending の 0817 も同じ blocker で止まっている。設計方針の最初の手順 (draft-23 リレーでの再観測) を実行できず、relay 側か moqt-js 側かの切り分けができない。

再開時は、draft-23 対応リレーを `TEST_MOQT_URI` で用意し、0817 と同時に再開する。手順 2 の 4 実験 (0x02 の `{0, 0}` / 0x02 の `{currentGroup, 0}` / 省略形 / 省略形 + FILL TIMEOUT 0) を実行し、結果を「解決方法」に記録してから分岐する。
