# MSF Metrics track の payload を実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: 2026-07-31
- Model: Composer
- Branch: feature/add-msf-metrics-track-payload
- Polished: 2026-07-27

## 目的

draft-ietf-moq-msf-01 §10 の Metrics track は catalog の `publishTracks` で `packaging: "moqmetrics"` を宣言できるが、payload 生成・解釈は未実装である。`refs/moq/draft-jennings-moq-metrics-02.txt` に従い Metrics track payload を実装する。

## 優先度根拠

Log track と同様、catalog 宣言だけでは定量メトリクスを送れない。メディア再生パス自体は止まらないため Medium。

## 現状

- `PackagingType` に `"moqmetrics"` あり (`src/msf.ts:50`)。`RESERVED_TRACK_ROLES` に `"metrics"` あり (`src/msf.ts:76`)
- `#0316` (closed) で catalog 上の declare 型まで対応。payload は範囲外のまま
- msf-01 §10.1: payload は [MOQMETRICS] Section 3 の形式 (L3186-3187 MUST 参照)。データモデルは Resource / Attributes / Metrics (Gauge / Counter、float64 または int64)
- msf-01 §10.2: namespace / track name 形式。**§10.2 には "TODO: Finalize the track naming" (L3199) があり未確定**。本文は [MOQMETRICS] Section 3 の形式を MUST とする
- msf-01 §10.3: Group ID = capture time を **Unix epoch からのミリ秒** で表す (L3214-3215)。Object ID 0 = capture timestamp (Unix epoch **ナノ秒**) + attributes、Object ID 1 以降 = metric name-value pair
- msf-01 §10.4: packaging="moqmetrics" + role="metrics" の双方 MUST
- [MOQMETRICS] §2: データモデル定義。**"TODO: Define ABNF" (L140) があり正式な ABNF は未定義**
- [MOQMETRICS] §3: Group ID = "milliseconds since 1 Jan 1972 (NTP Era zero)" を 62-bit に truncate (L242-244)。Object 0 capture timestamp = Unix epoch ナノ秒 (L247-248)
- 一次資料: `refs/moq/draft-jennings-moq-metrics-02.txt`（**Expires: 2026-04-23 で期限切れ**。後継 draft なし。msf-01 が MUST 参照するため現時点で最新の参照仕様）
- **Group ID epoch の矛盾**: [MOQMETRICS] §3 は Group ID を "milliseconds since 1 Jan 1972 (NTP Era zero)" と定義するが、msf-01 §10.3 は "milliseconds since January 1, 1970 (Unix epoch)" と定義する。本 issue では **Group ID は msf-01 §10.3 に従い Unix epoch ミリ秒** とする
- **Group ID と Object 0 timestamp の単位不一致**: Group ID はミリ秒、Object 0 capture timestamp はナノ秒。単位が 10^6 倍異なる。実装時に相互変換が必要（コードコメントで注記する）
- [MOQMETRICS] §3.1 の JSON 例には構文誤りあり（L344 `value: 99` キー引用符なし、L358 JSON 内コメント）。テストベクタとして使用する場合は修正が必要
- `validatePackagingSpecificRules` (`src/msf.ts:1423-1469`) は `mediatimeline` / `eventtimeline` のみ処理し、`moqmetrics` 分岐は未実装
- 既存の `createInitialGroupId()` (`src/msf.ts:2469`) はメディアトラック用の `Date.now()` ベースであり、Metrics track の timestamp ベース Group ID とは意味が異なる

## 設計方針

1. [MOQMETRICS] Section 3 のデータモデルに従う encode / decode を新規モジュール `src/moqmetrics.ts` に追加する（#0348 Log track の `src/moqlog.ts` と対の構成）
2. Object ID 0 (capture timestamp + attributes) と Object ID 1 以降 (metric name-value pair) の 2 種類の payload を型定義する。Gauge / Counter の値は float64 / int64 の両方をサポートする
3. Group ID / Object ID の規則 (§10.3) を helper 化する。Group ID は Unix epoch ミリ秒とする（msf-01 §10.3 に従う）。62-bit への truncate を明示する。既存の `createInitialGroupId()` とは命名・責務を分離する
4. §10.2 の namespace / track name 形式は **仕様が TODO 付きのため暫定対応** とする。helper は [MOQMETRICS] Section 3 の現行テキストに従うが、変更を隔離できる設計にする（仕様確定時に helper 内部の修正で済むようにする）
5. catalog `publishTracks` の `packaging: "moqmetrics"` + `role: "metrics"` MUST 検証を `validatePackagingSpecificRules` に **新規追加** する（既存検証はない）
6. 高レベル API へのフル自動配線は必須としない

## 完了条件

- Object ID 0 (capture timestamp + attributes) と Object ID 1 以降 (metric name-value pair) の encode / decode round-trip テストがある
- Group ID / Object ID helper とテストがある（Unix epoch ミリ秒基準、62-bit truncate）
- §10.2 の namespace / track name helper がある（暫定対応である旨をコードコメントに明記）
- `validatePackagingSpecificRules` に `moqmetrics` + `role: "metrics"` の MUST 検証がある
- `CHANGES.md` の `## develop` に `[ADD]` を追記する
- `vp run test` / `vp run build` が pass する

## 関連

- `#0316` (closed) catalog 型までの先行対応
- `#0348` Log track payload (対になる publishTracks)

## 解決方法

draft-ietf-moq-msf-01 §10 / draft-jennings-moq-metrics-02 ([MOQMETRICS]) に従い、Metrics track の payload と catalog 検証を実装した。`src/moqlog.ts`（#0348）と対の構成。

- `src/moqmetrics.ts`（新規）: `MetricsCaptureObject`（Object 0: capture_timestamp ナノ秒 + attributes）/ `MetricObject`（Object 1 以降: metric_name + value、Gauge/Counter の float64/int64）の encode/decode（[MOQMETRICS] §3、fatal UTF-8 decode + ProtocolViolationError、共通 `decodeJsonObject`）、`METRICS_GRANULARITY_LEVELS`、`metricsGroupId()`（msf-01 §10.3、Unix epoch ミリ秒の 62-bit truncate）/ `metricObjectId()`、`metricsTrackNamespace()` / `metricsTrackName()`（[MOQMETRICS] §3、§10.2 の "TODO: Finalize the track naming" により暫定対応である旨を注記）。Group ID epoch の矛盾（[MOQMETRICS]§3 の 1972 vs msf-01§10.3 の 1970）と単位差（Group ID ミリ秒 / Object 0 ナノ秒）も注記する。
- `src/msf.ts`: `validatePackagingSpecificRules()` に moqmetrics 分岐を追加し、packaging="moqmetrics" は role="metrics" が MUST（§10.4）を検証する。
- `src/msf.prop.ts`: `catalogTrackArb` が moqmetrics 生成時に role="metrics" を固定する。
- `src/index.ts`: `export * as MOQMETRICS` で公開する。
- `src/moqmetrics.test.ts` / `src/moqmetrics.prop.ts`（新規）: Object 0 / Object 1 以降の round-trip（[MOQMETRICS] §3.1 の例、構文誤り修正版）、Group/Object ID、namespace/track name、エラーパスを検証する。`src/msf.test.ts` に moqmetrics + role=metrics の MUST 検証（直接経路 + clone 経路）を追加する。
- `CHANGES.md`: `## develop` に `[ADD]` を追記する。
