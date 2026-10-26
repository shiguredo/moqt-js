# FETCH の応答が届かない場合の catalog の取得を実リレーで確かめる

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/add-catalog-drain-e2e
- Polished: 2026-10-27

## 目的

受信タイムアウトのドレインで catalog を resolve する経路は、現行の E2E では FETCH が期限内に応答するため、ドレイン経路を確実には通していない。ドレイン経路そのものは合成セッションのテスト (`src/createMediaSubscriber.media.test.ts` の "FETCH の応答が終わらないまま期限に達しても live のフル catalog で resolve する") で固定されているが、既存の E2E (`tests/e2e/relay/devtools-publisher-catalog.spec.ts`) は devtools の publisher とライブラリの購読者の疎通を確かめるものであり、この経路の回帰ガードではない。実リレーで経路を通す手段があるかを確かめ、無い場合は既存の合成セッションのテストを被覆の層として確定し、E2E に判定しない理由を残す。

## 現状

- 実測 (2026-10-12、`moqt://sora-moq.shiguredo.co.jp/`) では、moqt-devtools の publisher の `MAX_CACHE_DURATION` を 0 にすると catalog の FETCH の応答が返らず、期限の時点で `catalogFetchInProgress: true` のまま受信タイムアウトになった。ただし同じ条件で relay が publisher の WebTransport を切断する事象 (`Connection lost.`) も観測しており、そのまま E2E にすると安定しない
- LOCATION FILTER を省略した FETCH は 21.5 秒間応答が返らない (原因の切り分けは 0785 が扱う)
- 現行の E2E は 2 経路 (SUBSCRIBE / FETCH) のどちらで catalog が届いたかを判定しないため、FETCH が応答しない場合の経路は判定に入らない

## 設計方針

- 実リレーで安定して再現できる条件を探す。候補は、devtools の publisher の `MAX_CACHE_DURATION` を 0 にする (catalog の送り直しは 1 秒ごとになる)、リレーの object cache が FETCH の要求範囲を覆わず上流へ転送される状態を作る (フィルタ無しの FETCH など)、の 2 つである
- 再現できない場合は「実リレーの E2E では被覆できない」と判定し、既存の合成セッションのテスト (`src/createMediaSubscriber.media.test.ts` の "FETCH の応答が終わらないまま期限に達しても live のフル catalog で resolve する" と `src/testSupport/mediaSubscriberTestSupport.ts` の `createCatalogTestSession`) を被覆の層として確定する。その場合、E2E には判定できない理由をコメントと issue に残す
- 0785 の切り分け (リレーが応答していないのか、応答がライブラリに届いていないのか) と結果を共有する。切り分けが済めば、フィルタ無しの FETCH を使う条件も選べる
- 実リレーの切断など環境依存の事象をテストの失敗にしない。判定は「catalog が届いて購読が始まること」に絞る

## 完了条件

- ドレイン経路が実リレーの E2E か合成セッションのテストで固定されている
- 実リレーで再現できた / できなかったの判定と、その根拠 (実測値・観測した事象) が issue に残り、再現できない場合は E2E に判定しない理由がコメントされている
- テストを追加・変更した場合は、そのテストが `vp test run` または実リレーの E2E で通る
- `vp check` / `tsc --noEmit` が通る

## 参照

- `tests/e2e/relay/devtools-publisher-catalog.spec.ts`
- `tests/e2e/relay/audio-timestamp.spec.ts` (環境依存の事象を判定にしない書き方の先例)
- `issues/0785-bug-fetch-without-location-filter-and-relative-filter-no-response.md`
- `src/createMediaSubscriber.media.test.ts` の "FETCH の応答が終わらないまま期限に達しても live のフル catalog で resolve する"
- `src/testSupport/mediaSubscriberTestSupport.ts` の `createCatalogTestSession`
- `src/createMediaSubscriber.ts` の `subscribeCatalog` (`CatalogSubscription.subscribe` への wrapper)
- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` / `rejectCatalogReceiveTimeout` / `finishCatalogFetchPhase`
