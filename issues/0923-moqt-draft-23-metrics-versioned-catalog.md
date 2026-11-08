# メトリクスの versioned catalog を追加し metricObjectId を変更する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-metrics-versioned-catalog
- Polished: 2026-11-08

## 目的

moq-metrics-03 §5.3 は、resource attributes と metric の説明を独立した catalog track へ移した。Metric Index の意味を前の data Group から継承せず、明示した catalog version で解釈するための変更である。

## 現状

- `src/moqmetrics.ts` の `MetricsCaptureObject` は data Object 0 に attributes を持ち、`MetricObject.metric_name` は省略時に前の Group から継承する
- catalog header / Metric Description の型や codec は存在しない
- `metricObjectId` は 0 始まりの配列 index + 1 を返すが、新仕様の Metric Index は catalog の Object ID 自体である

## 設計方針

- `src/moqmetrics.ts` に `MetricsCatalogHeader`（`formatVersion: bigint`、`attributes: readonly MetricsCatalogAttribute[]`）、`MetricsCatalogAttribute`（`{ key: string; value: string }`）、`MetricDescription`（`metricType: MetricType`、`valueRepresentation: MetricValueRepresentation`、`name: string`、`unit: string`）、`MetricType`（`"gauge" | "counter"`）、`MetricValueRepresentation`（`"unsigned" | "signed" | "float"`）を追加する。公開は `MOQMETRICS` namespace（`src/index.ts` の `export * as MOQMETRICS`）経由とし、named export は追加しない
- `encodeMetricsCatalogHeader` / `decodeMetricsCatalogHeader` と `encodeMetricDescription` / `decodeMetricDescription` を追加する。`METRICS_CATALOG_FORMAT_VERSION = 1n` とし、Header の `formatVersion` は 1n だけを受理する。Attribute の Key / Value と Unit は UTF-8（空文字を許す）、Name は ASCII の英数字・アンダースコア・コロンで、metric 名として空文字を拒否する。Attributes は順序と重複キーを保持する配列にする
- Catalog Header は Version (vi64)、Number of Attributes (vi64)、各 Attribute の Key / Value の vi64 length + UTF-8 bytes、Metric Description は Metric Type (vi64)、Value Representation (vi64)、Name の vi64 length + ASCII bytes、Unit の vi64 length + UTF-8 bytes の順で読み書きする。Metric Type は 0x0 Gauge / 0x1 Counter、Value Representation は 0x0 unsigned / 0x1 signed / 0x2 float に対応させる
- encode は文字コード・識別子・長さの違反を `Error` で拒否する。decode は vi64 自体の切り詰めを `IncompleteDataError`、宣言長が残りバイトを超える場合と未知の format Version / Metric Type / Value Representation、ASCII / UTF-8 違反を `ProtocolViolationError` で拒否する。定義済みフィールド後の将来拡張バイトは無視する
- catalog の Group ID は catalog version とし、`metricsCatalogGroupId(version: bigint): bigint` が 1 以上 2^64-1 以下の version を検証してそのまま返す。最初の version は 1、更新ごとに +1 する。Header の format Version と混同しない。Object 0 が header、Object N が Metric Index N の説明であり、Index を payload に重複して格納しない
- Metric Index は 1 つの catalog version 内で resource 全体に一意であり、data track ごとに 1 から振り直さない。複数の data track は同じ catalog version の同じ Index を同じ metric として参照する。新しい catalog version では再割当してよい (MAY) が、Object ID filter を保つため可能な限り同じ Index を維持する (SHOULD)。`metricObjectId` は一意性を検証せず、保証は呼び出し側の責務とする
- 公開 `metricObjectId(metricIndex: bigint)` は、1 以上 2^64-2 以下の Metric Index を検証してそのまま返す。0 は Header / Capture Info 用なので拒否し、配列 index へ暗黙に +1 しない。2^64-1 は data Group の End of Group Object ID が 2^64 になり vi64 で表現できないため拒否する。配列順序から Index を割り当てる利用例では、呼出し側で 1 始まりの Index を明示し、catalog と data の両方に同じ値を使う。旧 number / 0 始まりの呼出し・テスト・説明を更新する
- `metricObjectId` / `metricsCatalogGroupId` は bigint を返す。`Publisher.sendObject` の `groupId` / `objectId` は number (0〜2^53-1) のため `Number()` で渡す。data の Metric Index は End of Group の Object ID が `index + 1` になるため `2^53-2` 以下、catalog の description は `2^53-1` 以下（group を End of Group で閉じる場合は `2^53-2` 以下）、catalog version (Group ID) は `2^53-1` 以下の範囲で送信できる。新設する helper の JSDoc に、`sendObject` の対応範囲が 0〜2^53-1 であり、これを超える値は `metricObjectId` / `metricsCatalogGroupId` の検証範囲内でも精度を保証しない（送信層は `Number.isSafeInteger` を検査しない）ことを書く。`src/publisher.ts` の JSDoc は変更しない
- 0923 は `MetricDescription` 型と「data Object N の解釈には、参照する catalog version の Object N の description が必要であり、全 catalog や前の data Group は不要」という契約を定義する。data Object の Capture Info / Metric Value の codec（`encodeCaptureObject` / `decodeCaptureObject` / `encodeMetricObject` / `decodeMetricObject`）の置き換えは 0924 が担当し、0923 では変更しない
- catalog を参照する data より先に catalog を送る MUST、Subgroup delivery の MUST、MAX_CACHE_DURATION / DEFAULT_PUBLISHER_PRIORITY / OBJECT_DELIVERY_TIMEOUT の SHOULD、未取得 version を FETCH する責務を JSDoc に書く。既存の低レベル helper を超える自動 metrics 購読基盤は追加しない
- catalog の MAX_CACHE_DURATION は全 data track より短くせず、DEFAULT_PUBLISHER_PRIORITY は全 data track より数値を小さくし、OBJECT_DELIVERY_TIMEOUT を付けない推奨を JSDoc に明記する。MSF publishTracks に従って data を配信する場合も、同じ namespace の catalog を同じ connectionUri / token で公開する
- `src/moqmetrics.ts` の module JSDoc、`src/moqmetrics.test.ts` / `src/moqmetrics.prop.ts` の先頭、`docs/IMPLEMENTATION_STATUS.md` の MOQ Metrics を metrics-03 に更新する。catalog は metrics-03 §5.3、data Object は metrics-02 §3 のままと書き、0921 が入れた「payload は metrics-02」の記述をこの内容に置き換える。format Version と catalog Group ID の違い、必要な description だけで解釈できる点、Metric Index の一意性と版間の安定維持（SHOULD）を JSDoc に書く。CHANGES.md は CODEBASE.md の特別ルールにより更新しない
- Object ID filter の契約は 0924 が担当する。Track 名 / namespace は 0921、log は 0922 が担当する

## 完了条件

- Header / Description の固定ワイヤと round-trip を検証する。Attributes の順序と重複キー、Attribute の Key / Value と Unit の空文字、Name の ASCII と空文字拒否、Unit / Attribute の UTF-8、未知の format Version / Metric Type / Value Representation、vi64 の切り詰めと宣言長超過、末尾の将来拡張バイトを固定する
- `metricObjectId(1n)` が 1n、`metricObjectId(2n)` が 2n、`metricObjectId(2^64-2n)` が成功し、0 / `2^64-1n` / 負数を拒否する。`metricsCatalogGroupId(1n)` が 1n、`metricsCatalogGroupId(2^64-1n)` が成功し、`metricsCatalogGroupId(0n)` / `2^64n` / 負数を拒否する
- 同じ catalog version の Object 1 / 2 を複数の data track が同じ metric として参照し、version 1→2 で Index を維持する例と再割当する例を表現できる
- `Publisher.sendObject` の number 範囲（0〜2^53-1）と `Number()` 変換、data の Index が `2^53-2` 以下、catalog の description が `2^53-1` 以下（EOG で閉じる場合は `2^53-2` 以下）、catalog version が `2^53-1` 以下であることを新設する helper の JSDoc に書き、helper の戻り値の境界値（`2^53-2` / `2^53-1`）をテストする。範囲外は精度を保証しないことを明記する
- data Object の codec は 0923 では変更せず、data Object は metrics-02 §3 のままであることを JSDoc に書く（issue 番号は書かない）。data Object N の解釈に catalog Object N だけが必要で、全 catalog や前の data Group が不要であることを文書化する
- `src/moqmetrics.ts` / `src/moqmetrics.test.ts` / `src/moqmetrics.prop.ts` の先頭を metrics-03 にし、`docs/IMPLEMENTATION_STATUS.md` の MOQ Metrics を catalog は metrics-03 §5.3、data Object は metrics-02 §3 のままに更新し、Catalog Header / Metric Description の codec を API 列挙に追加する。test / prop の先頭にも data Object は metrics-02 §3 のままである注記を付ける。format Version と catalog Group ID の違い、Index の一意性と版間の安定維持を明記する
- 公開型・export・JSDoc・テストが新しい API に一致し、旧 `metricObjectId(number)` の 0 始まり呼出しが残らない

## 参照

- `refs/moq/draft-jennings-moq-metrics-03.txt` §4 / §5.1 / §5.3 / §5.4 / §5.10 / §6
- `refs/moq/draft-ietf-moq-msf-01.txt` §10.1 / §10.4
- `refs/moq/draft-ietf-moq-transport-23.txt` §8.1
- `src/moqmetrics.ts`、`src/varint.ts`、`src/error.ts`、`src/publisher.ts`、`src/index.ts`
- `src/moqmetrics.test.ts` / `src/moqmetrics.prop.ts`、`src/varint.test.ts`
- `docs/IMPLEMENTATION_STATUS.md` の MOQ Metrics
- `issues/0921-moqt-draft-23-observability-track-names.md`、`issues/0922-moqt-draft-23-log-binary-records.md`、`issues/0924-moqt-draft-23-metrics-binary-values.md`（担当範囲の境界）
- `issues/closed/0925-moqt-draft-23-activation-and-diff-audit.md`、`issues/0850-bug-moqlog-metrics-publishtracks-placement.md`、`issues/0865-change-catalog-fill-fetch.md`

## 解決方法

{未着手}
