# moqlog と moqmetrics の対称重複を共通化する

- Created: 2026-09-06
- Completed: 2026-09-14
- Branch: feature/refactor-observability-unify
- Polished: YYYY-MM-DD

## 目的

値同一の定数と同型ヘルパーが 2 モジュールに並立し、修正漏れの温床になる。共通化する必要がある。

## 現状

- severity 8 項目表、`GROUP_ID_MASK_62`、track namespace / name ヘルパー、JSON object 検証が `src/moqlog.ts` と `src/moqmetrics.ts` で同型である (差分は文字列と単位のみ)。

## 設計方針

1. 共有モジュールに寄せ、両者から利用する。
2. 検証強化 (`0489`) との順序を調整する (先後どちらでもよいが同時編集の競合に注意)。

## 完了条件

- 重複が除去され、既存テストが全て通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0489` (payload 検証強化)

## 解決方法

`src/observability.ts` を新設し、MOQLOG と MOQMETRICS で同型だった処理を集約した。公開名とエラー文言は変えていない。

### 共通化したもの

| 共通ヘルパー                  | 置き換えた実装                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `SYSLOG_LEVELS`               | `LOG_SEVERITY_LEVELS` / `METRICS_GRANULARITY_LEVELS` (8 項目が完全一致。両者は共有表の別名にした)                              |
| `observabilityGroupId`        | `logGroupId` / `metricsGroupId` の 62-bit truncate と非負検証                                                                  |
| `observabilityTrackNamespace` | `logTrackNamespace` / `metricsTrackNamespace` の空 resourceId 検証と 2 タプル構築                                              |
| `observabilityTrackName`      | `logTrackName` / `metricsTrackName` の 0-7 整数検証と 1 バイト化                                                               |
| `decodeObservabilityJson`     | `decodeLogEntry` のインライン実装と `moqmetrics` の `decodeJsonObject` (不正 UTF-8 / 非 object の `ProtocolViolationError` 化) |

`GROUP_ID_MASK_62` は両ファイルの private 定数だったため共有モジュール側の private 定数に一本化した。

### エラー文言の維持

MOQLOG / MOQMETRICS で文言が異なるため、ラベル (`"log group"` / `"metrics group"` / `"log priority"` / `"metrics granularity"` / `"moqlog"` / `"moqmetrics"` / `"moqmetrics capture object"` / `"moqmetrics metric object"`) を引数で受け取る形にした。`invalid moqlog payload JSON: ...` などの文言は既存テストで固定されているため変更していない。

### 検証

- `vp test run`: 98 ファイル / 2,177 テスト全通過 (テストは未変更)
- `vp pack` の実行時輸出 63 件が変更前と完全一致 (公開 API 不変)
- `src/moqlog.ts` 229 → 201 行、`src/moqmetrics.ts` 248 → 217 行、`src/observability.ts` 120 行
- `vp check` / `tsc --noEmit` / `vp pack` 通過
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
