# LOCATION FILTER の省略形と相対指定の FETCH に relay が応答しない

- Created: 2026-10-01
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-fetch-without-location-filter
- Polished: {YYYY-MM-DD}

## 目的

LOCATION FILTER には、省略 (「{0, 0} から Largest Object まで」の要求) と 1 フィールドの相対指定の 2 つの形がある (draft-ietf-moq-transport-21 Section 9.20.10)。しかし実リレーに対してこの 2 つの形の FETCH は完了せず、`session.fetch()` が解決しない。実リレーへ接続する E2E テストを追加した際に判明した。

省略形が使えないと、過去の Object を取得する経路の一部が実ワイヤで検証できない。加えて `createMediaSubscriber` のカタログ FETCH は、LARGEST_OBJECT が不明なときに `catalogFetchFilter` が `undefined` を返してこの形を送るため、カタログの過去 Object を取りこぼす原因になり得る。

## 現状

- `tests/e2e/relay/fetch.spec.ts` に LOCATION FILTER 無しの FETCH を追加して CI で実行したところ、`session.fetch()` が解決せず、テストページ側の 30 秒の上限で打ち切られた
- 続けて 1 フィールドの相対指定 (`{ startGroup: 2 }`) に差し替えても同じく解決しなかった
- 同じ namespace の同じ track に対する絶対開始 (`{ startGroup, startObject }`) の FETCH は 5〜9 秒で完了する。3 回の CI 実行で安定して成功している
- FILL TIMEOUT に 0 を指定して「即座に利用可能な Object だけ」を要求しても応答は返らない (draft-ietf-moq-transport-21 Section 9.20.6)
- 応答するのは絶対開始の 2 フィールドだけで、開始位置を Largest Object から導く形 (省略と相対指定) は応答しない
- 送信側のワイヤは `buildFetchParameters` が LOCATION FILTER を載せず、`encodeFetchPayload` が空の Parameters を書く。0 個のパラメータを持つ FETCH の符号化は `fetch.prop.ts` のラウンドトリップで固定されているが、relay が受理するかは実ワイヤでしか分からない
- アプリから見て FETCH_OK が返らないことは確定している。relay が応答していないのか、応答がライブラリに届いていないのかは未確定である
- 検証に使うリレーは、他リポジトリの E2E (SETUP と PUBLISH) が成功しており、接続と publish の経路は動作している

## 設計方針

- まず切り分ける。テストページの `ConnectCallbacks.debug` で受信したメッセージの種別を収集し、省略形と相対指定の FETCH に対して relay が何を返すか (FETCH_OK / REQUEST_ERROR / 無応答) を CI のログで確認する
- relay が無応答なら relay 側の問題として扱う。REQUEST_ERROR を返すならエラーコードと仕様の整合を確認する。FETCH_OK を返しているのに解決しないなら moqt-js 側の問題として修正する
- 省略形が使えないことが確定した場合、`createMediaSubscriber` のカタログ FETCH が `catalogFetchFilter` の `undefined` (LARGEST_OBJECT 不明) でこの形を送る経路への影響を確認する
- 切り分けが済むまでは `tests/e2e/relay/fetch.spec.ts` に省略形のテストを戻さない (CI を赤くしない)。戻す場合は、relay の対応状況が分かる形にする

## 完了条件

- 省略形と相対指定の FETCH に対して relay が返すものが特定されている
- 原因が moqt-js 側なら修正され、`tests/e2e/relay/fetch.spec.ts` にそれぞれの形の FETCH のテストが追加されている
- 原因が relay 側なら、その旨と `createMediaSubscriber` のカタログ FETCH への影響が issue に記録されている

## 参照

- draft-ietf-moq-transport-21 Section 9.11 (FETCH)
- draft-ietf-moq-transport-21 Section 9.12 (FETCH_OK)
- draft-ietf-moq-transport-21 Section 9.20.6 (FILL TIMEOUT Parameter)
- draft-ietf-moq-transport-21 Section 9.20.10 (LOCATION FILTER Parameter)
- `tests/e2e/relay/fetch.spec.ts` (絶対開始の 1 本のみを実行している)
- `src/session/params.ts` の `buildFetchParameters` / `resolveFetchStartLocation`
- `src/message/fetch.ts` の `encodeFetchPayload`
- `src/createMediaSubscriber.ts` の `catalogFetchFilter`
- e2e-test workflow の実行 (省略形と相対指定の FETCH がそれぞれ 30 秒の上限に達した失敗ログ)

## 解決方法

{未着手}
