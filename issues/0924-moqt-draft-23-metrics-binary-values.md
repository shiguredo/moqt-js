# メトリクスの Capture Info と値を catalog 参照のバイナリ形式にする

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-metrics-binary-values
- Polished: 2026-11-08

## 目的

moq-metrics-03 §5.4 は JSON の capture / metric Object を binary Capture Info と Metric Value に変更した。これにより 64 bit 整数の精度を保ち、catalog version だけで Group を独立に解釈できる。

## 現状

- `src/moqmetrics.ts` の `MetricsCaptureObject` / `encodeCaptureObject` / `decodeCaptureObject` と `MetricObject` / `encodeMetricObject` / `decodeMetricObject` は JSON を使い、未知フィールドを索引シグネチャで保持する
- capture_timestamp と value を number で扱い、64 bit 整数の精度損失を注意書きで利用者へ委ねる
- `metricsGroupId` は `observabilityGroupId` で 62 bit に切り詰める
- `metricObjectId` は 0923 で 1 始まりの `bigint` に変わる前提であり、本 issue では再変更しない

## 設計方針

- Object 0 を `MetricsCaptureInfo`（`timestampOffset: bigint`、`catalogVersion: bigint`、`MOQMETRICS` namespace 経由で公開し named export は追加しない）にする。`timestampOffset` は Group のミリ秒に足すナノ秒で 0 以上 10^6 未満、`catalogVersion` は catalog の Group ID で 1 以上 2^64-1 以下とする。Header の `formatVersion`（0923 の 1n）とは別物であり、0 は拒否する
- `encodeMetricsCaptureInfo(info: MetricsCaptureInfo): Uint8Array` / `decodeMetricsCaptureInfo(data: Uint8Array): MetricsCaptureInfo` を追加する。Capture Info は Timestamp Offset (vi64) と Catalog Version (vi64) の順で読み書きし、2 フィールドを読んだ後の末尾は将来拡張として無視する（§5.4 に明文はないが、§5.3 の将来拡張規則を Capture Info にも適用する本実装の方針である）。数値そのものが payload 全体である Metric Value と処理を分ける
- Object N の値は 0923 の `MetricDescription` に従い、`encodeMetricValue(description: MetricDescription, value: MetricValue)` / `decodeMetricValue(description: MetricDescription, payload: Uint8Array)` で読み書きする。`MetricValue` は整数の `bigint` と float の `number` の union とし、`valueRepresentation` が unsigned / signed なら bigint、float なら number だけを受理する
- unsigned は単一 vi64 が payload 全体を消費することを確認する。0 以上 2^64-1 以下を検証し、剰余による wrap を起こさない。signed は network byte order (big-endian) の厳密な 8 バイトとし、-2^63 以上 2^63-1 以下を DataView への書込み前に検証する。float は IEEE 754 binary64 を network byte order の厳密な 8 バイトで読み書きし、NaN / ±Infinity / -0 を含む binary64 をそのまま扱う
- encode は表現と値の型・範囲の違反を `Error` で拒否する。decode は vi64 自体の切り詰めを `IncompleteDataError`、signed / float の長さが 8 バイトでない場合、unsigned の余分なバイト、値域違反、型の不一致を `ProtocolViolationError` で拒否する
- 旧 `MetricsCaptureObject` / `MetricObject`、`encodeCaptureObject` / `decodeCaptureObject` / `encodeMetricObject` / `decodeMetricObject`、`metric_name` の継承、Object 0 の attributes、索引シグネチャによる未知フィールド保持は削除し、alias を残さない。data Object の解釈には参照する catalog version の同じ Object ID の `MetricDescription` だけが必要で、全 catalog や前の data Group を必要としない
- `metricsGroupId(timestampMs: bigint)` は Unix epoch ミリ秒をそのまま返し、0 以上 2^64-1 以下を検証する。62 bit truncate をやめる。`Publisher.sendObject` の `groupId` / `objectId` は number (0〜2^53-1) のため `Number()` で渡し、2^53 以上は `Number()` で値が変わり得るため送信できない場合がある（精度を保証しない）ことを JSDoc に書く
- 1 Group は Subgroup 0 の 1 本にまとめ、Datagram を使わない。Object 0 を先頭に送る。`metricObjectId` は 0923 が返す 1 始まりの Object ID をそのまま使う
- 各 Group の Object 0 に `PRIOR_GROUP_ID_GAP` を付け、値は前の capture からのミリ秒差 - 1（0 を含む）とする。前の capture が不明な場合（開始後最初の Group など）は付けない。skip された Object ID の次の Object に `PRIOR_OBJECT_ID_GAP` を付け、値は skip 数とする
- `metricsPriorGroupIdGap(previousGroupId: bigint | undefined, currentGroupId: bigint): bigint | undefined` を追加し、前が不明なら undefined、それ以外は `currentGroupId - previousGroupId - 1n` を返す。`metricsPriorObjectIdGap(previousObjectId: bigint, currentObjectId: bigint): bigint | undefined` を追加し、差が 1 なら undefined、それ以外は `currentObjectId - previousObjectId - 1n` を返す。`metricsEndOfGroupObjectId(largestMetricObjectId: bigint): bigint` を追加し、`largestMetricObjectId + 1n` を返す。各 helper は負数と増加しない ID を拒否し、`metricsEndOfGroupObjectId` は 0 以上 2^64-2 以下の入力だけを受理する
- End of Group は `status: ObjectStatus.END_OF_GROUP`、空 payload、properties なしで `Publisher.sendObject` に渡し、Object ID は `metricsEndOfGroupObjectId` の値にする。空 payload を `decodeMetricsCaptureInfo` / `decodeMetricValue` が data Object として受理しない。§5.10.2 の例（Prior Group ID Gap 999、Prior Object ID Gap 1、End of Group Object 3）を固定する。FETCH 応答では Object Status が運ばれないため、存在しない Object の表現は transport の仕様に従う
- metrics data track の Track Properties は §5.5 / §5.6 に従い、DEFAULT_PUBLISHER_PRIORITY は §5.2 の 128〜240、DEFAULT_PUBLISHER_GROUP_ORDER は Ascending、MAX_CACHE_DURATION と OBJECT_DELIVERY_TIMEOUT を設定する。§5.7 の catalog とレベルの購読、§5.9 の時間範囲 FETCH / fill を JSDoc に書く
- Object ID filter は Object 0 を含める MUST とし、同じ filter を catalog track にも適用する。Range Filter は relay の MAX_FILTER_RANGES が 0 でも処理できる最適化として扱う
- `src/observability.ts` から `GROUP_ID_MASK_62` / `observabilityGroupId` / `decodeObservabilityJson` を削除し、module JSDoc を `SYSLOG_LEVELS` / `observabilityTrackName` / `observabilityTrackNamespace` / `observabilityNamespaceTemplate` の共有に限定する。`src/moqmetrics.ts` の import も削除する。0922 が log から利用を外した後の後始末であり、0922 完了後に実施する
- `src/moqmetrics.ts` の module JSDoc、`src/moqmetrics.test.ts` / `src/moqmetrics.prop.ts` の先頭、`docs/IMPLEMENTATION_STATUS.md` の MOQ Metrics を metrics-03 §5.4 に更新し、0923 が入れた「data Object は metrics-02 §3 のまま」の記述を metrics-03 §5.4 に置き換える。MSF-01 §10.1 の JSON MUST と §10.3 の Object 0 の timestamp / attributes との不一致を「旧版」と書いて明記し、metrics-02 のリテラルを docs / JSDoc に残さない。CHANGES.md は CODEBASE.md の特別ルールにより更新しない

## 完了条件

- Capture Info の固定ワイヤと round-trip を検証する。`timestampOffset` の 0 / 999999 / 1000000、`catalogVersion` の 1 / 2 / 0 / 2^64-1 / 2^64 を固定し、末尾の将来拡張バイトを無視する
- unsigned の 2^53 + 1 / 2^64-1、signed の -2^63 / 2^63-1 / 2^63 / -2^63-1、float の 45.1 / +Infinity / -Infinity / -0 を固定ワイヤで検証し、NaN は `Number.isNaN` で検証する
- unsigned の負数 / 2^64、signed の 8 バイト以外、float の 8 バイト以外、unsigned の余分なバイト、整数に number / float に bigint を渡した場合を拒否する。Capture Info の拡張末尾は Metric Value と異なり無視する
- `decodeMetricValue` が catalog の `MetricDescription` だけで data を解釈でき、以前の Group の `metric_name` に依存しないことを検証する
- `metricsGroupId` が 0 / 2^53-1 / 2^64-1 をそのまま返し、負数 / 2^64 を拒否する。`Publisher.sendObject` の number 範囲と `Number()` 変換、2^53 以上は `Number()` で値が変わり得るため送信できない場合があることを JSDoc とテストで固定する
- `metricsPriorGroupIdGap(1720367991000n, 1720367992000n)` が 999n、`metricsPriorGroupIdGap(1720367991000n, 1720367991001n)` が 0n、`metricsPriorGroupIdGap(undefined, 1720367991000n)` が undefined になる。`metricsPriorObjectIdGap(0n, 2n)` が 1n、`metricsPriorObjectIdGap(0n, 1n)` が undefined になる。`metricsEndOfGroupObjectId(2n)` が 3n になる。各 helper の負数・減少・同値を拒否する
- Object 0 が必須であり、Subgroup 0 の 1 本・Datagram 不使用・End of Group（空 payload・properties なし・最大 Object ID + 1）の契約を、§5.10.2 の Prior Group ID Gap 999 / Prior Object ID Gap 1 / End of Group 3 と合わせて検証する
- `src/observability.ts` から `GROUP_ID_MASK_62` / `observabilityGroupId` / `decodeObservabilityJson` が消え、`rg 'observabilityGroupId|GROUP_ID_MASK_62|decodeObservabilityJson' src` が 0 件になる。`src/moqmetrics.test.ts` の 62-bit truncate テストを full 64 bit の境界テストへ置き換える
- `src/moqmetrics.ts` / `src/moqmetrics.test.ts` / `src/moqmetrics.prop.ts` の先頭を metrics-03 §5.4 にし、`docs/IMPLEMENTATION_STATUS.md` の MOQ Metrics を catalog は metrics-03 §5.3、data Object は metrics-03 §5.4 に更新する。`src/moqmetrics*` / `src/index.ts` / `docs/IMPLEMENTATION_STATUS.md` に metrics-02 と旧 `MetricsCaptureObject` / `MetricObject` / `encodeCaptureObject` の参照が残らない
- 公開型・export・JSDoc・テストが新しい API に一致し、`metricObjectId` を 0924 で再変更していない

## 参照

- `refs/moq/draft-jennings-moq-metrics-03.txt` §5.3〜§5.10 / §6
- `refs/moq/draft-ietf-moq-transport-23.txt` §8.1 / §10.8 / §10.9 / §11.1.1 / §11.1.2
- `refs/moq/draft-ietf-moq-msf-01.txt` §10.1 / §10.3 / §10.4
- `src/moqmetrics.ts`、`src/observability.ts`、`src/varint.ts`、`src/properties.ts`、`src/publisher.ts`、`src/error.ts`、`src/index.ts`
- `src/moqmetrics.test.ts` / `src/moqmetrics.prop.ts`、`src/varint.test.ts`、`src/properties.test.ts`
- `docs/IMPLEMENTATION_STATUS.md` の MOQ Metrics
- `issues/0921-moqt-draft-23-observability-track-names.md`、`issues/0922-moqt-draft-23-log-binary-records.md`、`issues/0923-moqt-draft-23-metrics-versioned-catalog.md`（担当範囲の境界。0923 完了後に着手する）
- `issues/closed/0925-moqt-draft-23-activation-and-diff-audit.md`、`issues/0864-add-publisher-prior-group-id-gap.md`

## 解決方法

{未着手}
