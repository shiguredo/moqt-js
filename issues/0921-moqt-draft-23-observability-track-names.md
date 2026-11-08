# ログとメトリクスの namespace を 3 field にしレベルの Track Name を ASCII 数字にする

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-observability-track-names
- Polished: 2026-11-08

## 目的

moq-log-04 §4 / §5.1 と moq-metrics-03 §4.1 / §5.1 は namespace を domain / v1 / resourceID の 3 field、レベルの Track Name を ASCII 数字に変更した。旧 URL 文字列 + resourceID とバイナリ 1 バイトの名前では新しい収集側が発見できない。

## 現状

- `src/moqlog.ts` の `MOQLOG_NAMESPACE_PREFIX` は `moq://moq-syslog.arpa/logs-v1/`
- `src/moqmetrics.ts` の `MOQMETRICS_NAMESPACE_PREFIX` は `moq://metrics.moq.arpa/v1/`
- 両 module は `src/observability.ts` の `observabilityTrackNamespace` で 2 field を作り、`observabilityTrackName` は 0〜7 をそのまま 1 バイトにする

## 設計方針

- `src/observability.ts` の `observabilityTrackNamespace(prefix: readonly [string, string], resourceId: string, what: string)` は、prefix の 2 field の後ろへ resourceID を加えた `[string, string, string]` を返す。ログは `["logs.moq.arpa", "v1", resourceID]`、メトリクスは `["metrics.moq.arpa", "v1", resourceID]` とする
- `MOQLOG_NAMESPACE_PREFIX` は `readonly ["logs.moq.arpa", "v1"]`、`MOQMETRICS_NAMESPACE_PREFIX` は `readonly ["metrics.moq.arpa", "v1"]` にする。`logTrackNamespace(resourceId)` / `metricsTrackNamespace(resourceId)` の戻り値は 3 field の tuple にする
- resourceID は 16 桁の小文字 hexadecimal ASCII として検証する。ブラウザから MAC address を取得する機能は追加せず、生成・保持は利用者の責務とする
- `observabilityTrackName(level, label)` は 0〜7 を ASCII `0x30`〜`0x37` の 1 バイトにする。`logTrackName` / `metricsTrackName` の戻り値は `Uint8Array` のままにする。metrics の catalog Track Name 用に `metricsCatalogTrackName(): Uint8Array` を追加し、`src/msf/version.ts` の `CATALOG_TRACK_NAME`（`"catalog"`）と同じ ASCII バイト列を返す。data track の `"0"`〜`"7"` と混同しない
- `observabilityNamespaceTemplate(prefix: readonly [string, string]): string` を追加し、固定の 2 field prefix だけを `formatTrackNamespace` で serialize した後、末尾へ文字列 `-%resourceId%` を連結する（log-04 §6 / metrics-03 §6 が §8.8 形式と `%resourceId%` placeholder を定める）。`MOQLOG_NAMESPACE_TEMPLATE` / `MOQMETRICS_NAMESPACE_TEMPLATE` はこの helper で作り、`logs.2emoq.2earpa-v1-%resourceId%` / `metrics.2emoq.2earpa-v1-%resourceId%` にする。placeholder を含む 3 field tuple 全体を serialize して `%` を `.25` に変換しない。実際の resourceID を含む 3 field namespace の文字列表現は `formatTrackNamespace` で作る
- template は `resolveCatalogVariables` で置換してから `parseTrackNamespace` で読む。ログ / metrics 用の置換済み resourceID を 16 桁小文字 hexadecimal として検証し、復元した 3 field が `logTrackNamespace` / `metricsTrackNamespace` の tuple と一致することを確認する。未置換 template を実 namespace として parse しない。`resolveCatalogVariables` と `parseTrackNamespace` は公開 API ではないため、利用者は `logTrackNamespace` / `metricsTrackNamespace` で実 namespace を作り、template は MSF catalog の `namespace` 文字列として使う
- 本 issue は命名だけを担当する。payload / Group ID / catalog codec / Track Properties / FETCH / fill と、module 先頭の対応 draft 表記・payload の説明は 0922 / 0923 / 0924 が担当し、本 issue で先取りしない。module 先頭の「注意（track naming は暫定）」など命名に関する記述は本 issue で更新する
- MSF-01 §§9 / 10 は旧 log / metrics 版を固定参照している。本変更は最新 companion draft の形式を採用するものであり、`docs/IMPLEMENTATION_STATUS.md` の MOQ Log / MOQ Metrics と各 module の命名に関する JSDoc に、名前は log-04 §5.1 / metrics-03 §5.1、payload は引き続き log-03 §4 / metrics-02 §3（MSF-01 §9.1 / §10.1）である旨を明記する。既存 0850 の publishTracks 配置検証は別目的である

## 完了条件

- `MOQLOG_NAMESPACE_PREFIX` / `MOQMETRICS_NAMESPACE_PREFIX` が 2 field、`logTrackNamespace` / `metricsTrackNamespace` が 3 field を返し、値が `["logs.moq.arpa", "v1", <16 桁小文字 hexadecimal>]` / `["metrics.moq.arpa", "v1", <同>]` になる。この 3 field を `formatTrackNamespace` で文字列にし、`parseTrackNamespace` で戻すと元の tuple になる
- resourceID が 16 桁小文字 hexadecimal でない場合（空・大文字・15 桁・17 桁・非 hex）に throw する
- `logTrackName(0)`〜`logTrackName(7)` / `metricsTrackName(0)`〜`metricsTrackName(7)` が ASCII `0x30`〜`0x37` の 1 バイトを返す。`metricsCatalogTrackName()` が ASCII の `catalog` を返し、data track の `"0"`〜`"7"` と一致しない
- `MOQLOG_NAMESPACE_TEMPLATE` / `MOQMETRICS_NAMESPACE_TEMPLATE` が `logs.2emoq.2earpa-v1-%resourceId%` / `metrics.2emoq.2earpa-v1-%resourceId%` と一致する。`resolveCatalogVariables` で `resourceId` を 16 桁小文字 hexadecimal に置換した後 `parseTrackNamespace` で 3 field に戻せる。未置換 template は `parseTrackNamespace` が拒否し、placeholder を含む 3 field tuple を `formatTrackNamespace` に渡すと `%` が `.25` になって置換できないことも固定する
- `docs/IMPLEMENTATION_STATUS.md` と命名に関する JSDoc に、名前は log-04 / metrics-03、payload は log-03 / metrics-02 のままで、MSF-01 §§9 / 10 が旧版を参照していることを明記する
- 旧 URL prefix / バイナリ Track Name の使用箇所（`src/moqlog.test.ts` / `src/moqmetrics.test.ts` / `src/moqlog.prop.ts` / `src/moqmetrics.prop.ts`）と説明を移行する

## 参照

- `refs/moq/draft-jennings-moq-log-04.txt` §4 / §5.1 / §6
- `refs/moq/draft-jennings-moq-metrics-03.txt` §4.1 / §5.1 / §6
- `refs/moq/draft-ietf-moq-msf-01.txt` §9 / §10
- `refs/moq/draft-ietf-moq-transport-23.txt` §8.8
- `src/observability.ts`、`src/moqlog.ts`、`src/moqmetrics.ts`、`src/msf/variables.ts`、`src/msf/version.ts`
- `src/fullTrackName.ts` の `formatTrackNamespace` / `parseTrackNamespace`、`src/fullTrackName.test.ts`
- `src/msf.test.ts` の `resolveCatalogVariables` のテスト
- `docs/IMPLEMENTATION_STATUS.md` の MOQ Log / MOQ Metrics
- `issues/0922-moqt-draft-23-log-binary-records.md`、`issues/0923-moqt-draft-23-metrics-versioned-catalog.md`、`issues/0924-moqt-draft-23-metrics-binary-values.md`（担当範囲の境界）

## 解決方法

{未着手}
