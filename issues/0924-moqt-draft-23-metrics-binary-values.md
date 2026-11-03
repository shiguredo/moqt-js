# メトリクスの Capture Info と値を catalog 参照のバイナリ形式にする

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-metrics-binary-values
- Polished: {YYYY-MM-DD}

## 目的

moq-metrics-03 §5.4 は JSON の capture / metric Object を binary Capture Info と Metric Value に変更した。これにより 64 bit 整数の精度を保ち、catalog version だけで Group を独立に解釈できる。

## 現状

- `src/moqmetrics.ts` の `encodeCaptureObject` / `decodeCaptureObject` と `encodeMetricObject` / `decodeMetricObject` は JSON を使う
- capture_timestamp と value を number で扱い、64 bit 整数の精度損失を注意書きで利用者へ委ねる
- `metricsGroupId` は `observabilityGroupId` で 62 bit に切り詰める

## 設計方針

- Object 0 を Capture Timestamp Offset (vi64、Group のミリ秒に足すナノ秒で 10^6 未満) と Catalog Version (vi64) にする
- Object N の値を 0923 の Metric Description に従って、unsigned vi64、network byte order の signed int64、IEEE 754 binary64 で読み書きする
- 整数を bigint で保持する。古い JSON の metric_name 継承と Object 0 の attributes を削除し、対応する catalog の説明・header を参照する
- Group ID は Unix epoch ミリ秒の full 64 bit とし、62 bit truncate をやめる。Metric Index と Object ID の関係を新 catalog に揃える
- Subgroup 0、必須 Object 0、欠ける metric の Prior Object ID Gap、End of Group、推奨 Prior Group ID Gap を利用者が正しく構築できる契約と helper を整備する
- Object ID filter は 0 を含める必要があり、peer の Range Filter 非対応時にも処理できることを説明する
- MSF-01 の旧 JSON / timestamp の契約との不一致を明記する。名前は 0921、catalog は 0923 が担当する

## 完了条件

- 2^53 を超える unsigned、signed int64 の上下限、binary64、offset の境界を固定ワイヤで検証する
- catalog 参照だけで data を解釈でき、以前の Group の metric_name に依存しない
- 必須 Object 0、skip・gap・終了 Object の意味を混同しない
- 最新仕様の例と公開 API / export / テストが一致する

## 参照

- `refs/moq/draft-jennings-moq-metrics-03.txt` §5.3〜§5.10 / §6
- `src/moqmetrics.ts`、`src/observability.ts`、`src/moqmetrics.test.ts` / `moqmetrics.prop.ts`、`src/index.ts`

## 解決方法

{未着手}
