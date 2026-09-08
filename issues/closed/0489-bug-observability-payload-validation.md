# moqlog / moqmetrics の payload 検証を強化する

- Created: 2026-09-06
- Completed: 2026-09-08
- Branch: feature/fix-observability-validation
- Polished: 2026-09-06

## 目的

moqmetrics の必須フィールド欠落や非有限数が黙って通り、型契約と wire 値がずれる。moqlog の既知フィールド型誤りも受理する。型契約どおりに検証する必要がある。

## 現状

- `src/moqmetrics.ts` の `decodeCaptureObject` / `decodeMetricObject` は JSON object であることしか検証せず、`{}` や `value` 欠落が通る。型宣言は `capture_timestamp`・`value` を必須にしている (`metric_name` は optional)。`LogEntry` は一次資料どおり全フィールド optional のため必須化の対象外である。
- `encodeCaptureObject` / `encodeMetricObject` / `encodeLogEntry` は `JSON.stringify` 素通しのため、非有限数 (`NaN` / `Infinity`) が `null` 化して送出される。デコード側は `null` をそのまま返す。
- `src/moqlog.ts` の `decodeLogEntry` は既知フィールドの型誤り (`severity` 数値等) を受理する。
- 空 `resourceId` は `logTrackNamespace` / `metricsTrackNamespace` で検査せず素通しする (下流の Track Namespace エンコードで拒否される)。transport §2.4.1 は各 namespace 要素に 1 バイト以上を MUST とする。
- 共通の JSON object 検証は両モジュールで重複している (共通化は `0502` に寄せ、本 issue では行わない)。

## 設計方針

1. moqmetrics のデコード時に `capture_timestamp`・`value` の存在と数値型を検証し、違反は `ProtocolViolationError` とする。moqlog のデコード時に既知フィールドの型 (`severity` は string 等) を検証する。値列挙の厳格化 (severity 短縮形の可否等) はしない (§7 例との衝突を避ける)。
2. エンコード時に非有限数を `Error` で失敗させる (fail-fast。既存ヘルパーと同一クラス)。
3. `logTrackNamespace` / `metricsTrackNamespace` で空 `resourceId` を `Error` とする (transport §2.4.1)。
4. 境界値テストを追加する。`0496` の pin は本 issue の変更後を対象とする (順序: 0489 → 0496)。

## 完了条件

- moqmetrics の欠落・型誤りがデコード時に `ProtocolViolationError` になること。moqlog の既知フィールド型誤りがデコード時に検出されること。
- 非有限数のエンコードが `Error` になること。
- 空 `resourceId` の namespace 構築が `Error` になること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- `src/moqmetrics.ts` のデコード時に `capture_timestamp`・`value` の有限数値型を検証し、違反は `ProtocolViolationError` とする。`src/moqlog.ts` のデコード時に既知 8 フィールドの型を検証する。値列挙は厳格化しない
- 既知数値フィールドの非有限数のエンコードは `Error` で失敗させ、空 `resourceId` の namespace 構築は `Error` とする
- `src/moqlog.prop.ts` の生成器を型適合に絞り、未知キーの `__proto__` を除外する
- `src/moqmetrics.test.ts` と `src/moqlog.test.ts` に境界値テスト 10 件を追加した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 関連

- draft-jennings-moq-log-03 §3 / §4、draft-jennings-moq-metrics-02 §3、draft-ietf-moq-transport-20 §2.4.1
- `0502` (JSON object 検証の共通化。そちらに寄せる)
- `0496` (境界値の pin。本 issue の変更後を対象とする)
