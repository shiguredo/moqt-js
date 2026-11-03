# メトリクスの versioned catalog と Metric Description を追加する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/add-metrics-versioned-catalog
- Polished: 2026-11-03

## 目的

moq-metrics-03 §5.3 は、resource attributes と metric の説明を独立した catalog track へ移した。Metric Index の意味を前の data Group から継承せず、明示した catalog version で解釈するための変更である。

## 現状

- `src/moqmetrics.ts` の `MetricsCaptureObject` は data Object 0 に attributes を持ち、`MetricObject.metric_name` は省略時に前の Group から継承する
- catalog header / Metric Description の型や codec は存在しない
- `metricObjectId` は 0 始まりの配列 index + 1 を返すが、新仕様の Metric Index は catalog の Object ID 自体である

## 設計方針

- Catalog Header (format Version=1、resource Attributes) と Metric Description (Metric Type、Value Representation、Name、Unit) の binary codec を追加する
- catalog の Group ID は catalog version とし、1 から更新ごとに増やす。Header の format Version と混同しない
- Object 0 が header、Object N が Metric Index N の説明である。Index を payload に重複して格納しない
- 公開 metricObjectId(metricIndex: bigint) は、1 以上 2^64-1 以下の Metric Index を検証してそのまま返す。0 は Header / Capture Info 用なので拒否し、配列 index へ暗黙に +1 しない。配列順序から Index を割り当てる利用例では、呼出し側で 1 始まりの Index を明示し、catalog と data の両方に同じ値を使う。旧 number / 0 始まりの呼出し・テスト・説明を更新する
- Gauge / Counter、unsigned vi64 / signed int64 / float64 の識別子を型で表現し、定義済みフィールド後の将来拡張バイトは無視する
- data Object の decode には参照先 catalog の該当 description が必要である契約を定める。全 catalog や前の data Group が無いと解釈できない設計にしない
- catalog を参照する data より先に送る規則、Subgroup delivery、保持期間・優先度、未取得 version を FETCH する責務を説明する。既存の低レベル helper を超える自動 metrics 購読基盤は追加しない
- catalog の MAX_CACHE_DURATION は全 data track より短くせず、DEFAULT_PUBLISHER_PRIORITY は全 data track より数値を小さくし、OBJECT_DELIVERY_TIMEOUT を付けない推奨を明記する。MSF publishTracks に従って data を配信する場合も、同じ namespace の catalog を同じ connectionUri / token で公開する

## 完了条件

- Header / Description の固定ワイヤと round-trip、文字コード・長さ・識別子を検証する
- 版が変わった時の Index の再割当と、同じ catalog version の複数 data track での共有を表現できる
- Metric Index 1 / 2 が catalog と data の Object ID 1 / 2 に直接対応し、metricObjectId(1n) は 1n、metricObjectId(2n) は 2n となる。0 と vi64 範囲外は拒否する
- format Version と catalog Group ID の違い、必要な description だけで解釈できる点を文書化する
- データ形式の更新は 0924、Track 名は 0921 と整合する

## 参照

- `refs/moq/draft-jennings-moq-metrics-03.txt` §5.1 / §5.3 / §5.8
- `src/moqmetrics.ts`、`src/moqmetrics.test.ts` / `moqmetrics.prop.ts`、`src/index.ts`

## 解決方法

{未着手}
