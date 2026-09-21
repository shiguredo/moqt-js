# Object 受信経路で同じデータを繰り返しデコード・再構築している

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-receive-path-redundant-work
- Polished: {YYYY-MM-DD}

## 目的

Object 1 件を配送するまでに、同じ Properties バイト列を何度もデコードし、Object ごとに不変な比較キーとフィルタのグルーピングを作り直している。受信レートに比例して無駄な CPU 時間と GC 圧力が増える。

## 現状

- (a) 同一 Object の Properties バイト列が `decodeObjectPropertiesTolerant` で 3 回デコードされる。`src/dataStream/subgroup.ts` の `decodeObjectFields` が呼ぶ `assertNoMandatoryTrackPropertyInObjectProperties`、`src/session/stream.ts` の `processSubgroupObjects` が呼ぶ `assertPriorIdGapInObjectProperties`、同じ場所から `src/session/priorGapTracking.ts` の `assertNoPriorIdGapTrackViolation` を経由する `readPriorIdGaps` である。加えて `decodeObjectFields` の `assertKnownPropertyValueInObjectProperties` が生バイトを独自に走査し、Subgroup 先頭 Object では `readDeliveryTimeoutObjectProperties` が 4 回目のデコードを行う。datagram 経路も `src/dataStream/datagram.ts` の `decodeObjectDatagram` と `src/session/incoming.ts` の `incomingHandleDatagram` で同じ重複がある
- (a) の測定: Properties 2 バイトのデコード 1 回が約 78 ns。KVP 数に比例して増える (124 バイト / 62 KVP で約 3.4 µs)
- (b) datagram の Type Flags と Track Alias を最大 3 回デコードする。`src/session/incoming.ts` の `incomingResolveDatagramTrackKey` が `decodeDatagramTrackAlias` で 1 回、`incomingHandleDatagram` の PADDING 判定が `decodeVarint` で 1 回、`src/dataStream/datagram.ts` の `decodeObjectDatagram` が `decodeDatagramTypeAndTrackAlias` で 1 回である
- (b) の測定: `decodeDatagramTypeAndTrackAlias` 1 回が約 62 ns。このうち 2 回分が datagram あたりの上乗せになる
- (c) `src/subscriber.ts` の `SubscriberImpl.getFullTrackNameKey` は `src/fullTrackName.ts` の `fullTrackNameKey` を毎回呼び、配列と文字列を確保する。キャッシュが無いため、datagram では 1 件ごと、Subgroup では読み取りチャンクごとに作り直す。測定: 約 61 ns/回 (`fullTrackNameKey` 単体で約 79 ns/回)
- (d) `src/filter.ts` の `rangeFiltersMatch` は呼ばれるたびに SetID ごとの `Map` と配列を作り直す。`SubscriberImpl.passesObjectFilters` が Object ごとに呼ぶ。測定: Filter なし 4.6 ns に対し Filter 1 本で 28.7 ns (差の約 24 ns がグルーピングの再構築)

## 設計方針

- (a)(b) は 1 回デコードした結果を引数で引き回し、以降はその結果だけを見る
- (c)(d) は購読確立時に 1 回だけ作って保持する。フィルタは REQUEST_UPDATE で変わるため、変更時にだけ作り直す
- 中間表現を増やすと Object ごとの確保が増えるため、引き回す値は Object をまたいで再利用できる形にする

## 完了条件

- 各項目の再デコード・再構築が 1 回になり、既存テストが通る
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
