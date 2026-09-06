# moqlog / moqmetrics の payload 検証を強化する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-observability-validation
- Polished: YYYY-MM-DD

## 目的

必須フィールド欠落や非有限数が黙って通り、後段で静かに `NaN` になる。型契約どおりに検証する必要がある。

## 現状

- `src/moqmetrics.ts` の `decodeCaptureObject` / `decodeMetricObject` は JSON object であることしか検証せず、`{}` や `value` 欠落が通る。型宣言は `capture_timestamp`・`value` を必須にしている。
- `encodeMetricObject` 等は `NaN` を `null` 化して送出する (有限数検証なし)。
- `src/moqlog.ts` の `decodeLogEntry` は既知フィールドの型誤り (`severity` 数値等) を受理する。`resourceId` 空文字も素通しする。
- 共通の JSON object 検証は両モジュールで重複している。

## 設計方針

1. 必須フィールド・有限数・既知フィールド型・空 `resourceId` を検証し、違反は `ProtocolViolationError` とする。
2. 共通検証を共通化し、境界値テストを追加する。

## 完了条件

- 欠落・非有限数・型誤りがデコード / エンコード時に検出されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-jennings-moq-log-03 §3 / §4、draft-jennings-moq-metrics-02 §3
