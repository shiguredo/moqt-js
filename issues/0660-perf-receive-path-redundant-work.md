# Object 受信経路で同じデータを繰り返しデコード・再構築している

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-receive-path-redundant-work
- Polished: 2026-11-14

## 目的

Object 1 件を配送するまでに、同じ Properties バイト列や datagram の先頭フィールドを何度もデコードし、Track 単位で不変な比較キーと購読単位で不変なフィルタのグルーピングを Object ごとに作り直している。受信レートに比例して無駄な CPU 時間と GC 圧力が増える。

## 現状

- (a) 同一 Object の外側の Properties バイト列が `decodeObjectPropertiesTolerant` で 5 回デコードされる。内訳は、`src/dataStream/subgroup.ts` の `decodeObjectFields` が呼ぶ `assertNoMandatoryTrackPropertyInObjectProperties` / `assertPropertyScopesInObjectProperties` / `assertNoDuplicateSupportedPropertiesInObjectProperties`、`src/session/stream.ts` の `processSubgroupObjects` が呼ぶ `assertPriorIdGapInObjectProperties`、同じ場所から `src/session/priorGapTracking.ts` の `assertNoPriorIdGapTrackViolation` を経由する `readPriorIdGaps` である。加えて `decodeObjectFields` の `assertKnownPropertyValueInObjectProperties` が生バイトを独自に走査する (寛容デコードではない)。Subgroup の先頭 Object で FIRST_OBJECT ビットが立ち Properties がある場合、`readDeliveryTimeoutObjectProperties` が 6 回目のデコードを行う
- (a) datagram 経路も `src/dataStream/datagram.ts` の `decodeObjectDatagram` が `assertNoMandatoryTrackPropertyInObjectProperties` / `assertPropertyScopesInObjectProperties` / `assertNoDuplicateSupportedPropertiesInObjectProperties` / `assertKnownPropertyValueInObjectProperties` / `assertPriorIdGapInObjectProperties` を呼び、`src/session/incoming.ts` の `incomingHandleDatagram` が `assertNoPriorIdGapTrackViolation` を呼ぶため、同じ 5 回の寛容デコードの重複がある (生バイト走査は別)
- (a) FETCH / fill fetch 経路も `src/dataStream/fetch.ts` の `decodeFetchObjectFields` が同じ検証関数群を呼び、`src/session/stream.ts` の `processFetchObjects` が `assertNoPriorIdGapTrackViolation` を呼ぶため、同じ 5 回の寛容デコードの重複がある (生バイト走査は別。delivery timeout の抽出は Subgroup 経路だけ)
- (a) の回数は外側の Properties バイト列を対象にしている。IMMUTABLE_PROPERTIES (0x0B) の内側は、各検証関数が従来どおり必要な分だけデコードする (内側の統合は本 issue の対象外)
- (a) の測定 (作成時点の実測値。実行環境に依存): Properties 2 バイトのデコード 1 回が約 78 ns。KVP 数に比例して増える (124 バイト / 62 KVP で約 3.4 µs)
- (b) 通常の datagram 1 件につき Type Flags を 3 回、Track Alias を 2 回デコードする。`src/session/incoming.ts` の `incomingResolveDatagramTrackKey` が `decodeDatagramTrackAlias` で 1 回、`incomingHandleDatagram` の PADDING 判定が `decodeVarint` で 1 回、`src/dataStream/datagram.ts` の `decodeObjectDatagram` が `decodeDatagramTypeAndTrackAlias` で 1 回である。MalformedTrackError の catch でも `decodeDatagramTrackAlias` が Track Alias を読むため、エラー経路を含めると Type Flags 4 回・Track Alias 3 回になる
- (b) の測定 (作成時点の実測値。実行環境に依存): `decodeDatagramTypeAndTrackAlias` 1 回が約 62 ns。余分な `decodeDatagramTypeAndTrackAlias` 1 回と PADDING 判定の `decodeVarint` 1 回が datagram あたりの上乗せになる
- (c) `src/subscriber.ts` の `SubscriberImpl.getFullTrackNameKey` と `src/fetcher.ts` の `FetcherImpl.getFullTrackNameKey` は `src/fullTrackName.ts` の `fullTrackNameKey` を毎回呼び、配列と文字列を確保する。キャッシュが無いため、datagram では 1 件ごと、Subgroup では読み取りチャンクごと、FETCH / fill fetch でも読み取りチャンクごとに作り直す。測定 (作成時点の実測値。実行環境に依存): 約 61 ns/回 (`fullTrackNameKey` 単体の測定では約 79 ns/回。同じ入力で測ると両者は同程度であり、差は測定誤差の範囲)
- (d) `src/filter.ts` の `rangeFiltersMatch` はフィルタがあるときに呼ばれるたびに SetID ごとの `Map` と配列を作り直す。`SubscriberImpl.passesObjectFilters` が Object ごとに呼ぶ。測定 (作成時点の実測値。実行環境に依存): Filter なし 4.6 ns に対し Filter 1 本で 28.7 ns (差の約 24 ns がグルーピングの再構築)

## 設計方針

- (a) は外側の Properties バイト列を 1 回だけ寛容デコードし、その結果を引数で引き回して以降の寛容デコードを必要とする検証はその結果だけを見る (FETCH / fill fetch 経路も含む)。`decodeObjectFields` / `decodeObjectDatagram` / `decodeFetchObjectFields` の戻り値に寛容デコード結果を持たせ、`processSubgroupObjects` / `incomingHandleDatagram` / `processFetchObjects` はそれを使う
- (b) は datagram の先頭フィールドを 1 回だけデコードし、その結果を PADDING 判定・Track Alias の解決・`decodeObjectDatagram` で共有する。MalformedTrackError の catch も同じ結果を使い、再デコードしない
- (a) の 1 回化は `assertKnownPropertyValueInObjectProperties` の厳格検査 (既知 Type の `SessionError` (`MALFORMED_KEY_VALUE`) / `ProtocolViolationError` (`MALFORMED_KEY_VALUE` / `FIELD_LENGTH_EXCEEDED` / `DELTA_ENCODING_OVERFLOW`) の投げ分け) を壊さないこと。寛容デコードの出力だけではこの検査に代えられないため、生バイトの走査は従来どおり 1 回行う
- (a) の回数は外側の Properties バイト列を対象にする。IMMUTABLE_PROPERTIES (0x0B) の内側は、各検証関数が従来どおり必要な分だけデコードする (内側の統合は本 issue の対象外)
- (c) は `SubscriberImpl` / `FetcherImpl` のインスタンス生成時に 1 回だけ作って保持する。(d) は購読のフィルタ設定時に 1 回だけグルーピングを作って保持し、フィルタは REQUEST_UPDATE で変わるため、`setRangeFilters` で変更されたときにだけ作り直す。削除エントリ (`remove`) の除外を含め、現在の `rangeFiltersMatch` と同じ評価規則を保つ
- `rangeFiltersMatch` は publisher / bidi の送信側からも呼ばれるため、グルーピングだけを関数として切り出し、購読側が結果を保持する形にする。送信側の呼び出し規約は変えない
- 寛容デコードの結果は Object ごとに 1 つだけ作り、同じ Object 内の複数の検証で共有する。検証ごとに `Property[]` を作り直さず、追加のラッパーオブジェクトも作らない

## 完了条件

- (a) 外側の Properties バイト列の寛容デコードが Object ごとに 1 回になり、Subgroup 先頭 Object の delivery timeout 抽出も、外側の同じデコード結果を使う。`assertKnownPropertyValueInObjectProperties` の生バイト走査は従来どおり 1 回行う
- (b) datagram の Type Flags と Track Alias のデコードが datagram 1 件につき 1 回になり、PADDING 判定と MalformedTrackError の catch も同じ結果を使う
- (c) `SubscriberImpl` / `FetcherImpl` の比較キーがインスタンスごとに 1 回だけ生成され、受信のたびに `fullTrackNameKey` を呼ばない
- (d) 購読の Range Filter のグルーピングがフィルタ設定時に 1 回だけ作られ、Object ごとに SetID のグルーピングを作り直さない
- 既存テストが通り、`npx vp check` / `npx vp test run` が通る

## 解決方法

{未着手}
