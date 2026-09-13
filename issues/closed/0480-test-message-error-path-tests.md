# message 層 4 モジュールに異常系テストがない

- Created: 2026-09-06
- Completed: 2026-09-14
- Branch: feature/add-message-error-tests
- Polished: YYYY-MM-DD

## 目的

PBT は正常系 round-trip のみを検証し、意図的なエラーパス・境界値の検証がない。PBT で実現できないケースは単体テストで書く規約に従う必要がある。

## 現状

- `src/message/subscribe.ts` / `publish.ts` / `trackstatus.ts` / `namespace.ts` に対応する `*.test.ts` がなく、`trailing data` / 上限超過 / フィールド数違反等の `PROTOCOL_VIOLATION` 分岐が未検証である。
- `fetch` / `setup` / `parameter` / `session` は `*.test.ts` を持つため不整合である。

## 設計方針

1. 4 モジュールに `*.test.ts` を追加し、異常系・境界値を検証する。
2. PBT と役割分担し、重複は避ける。

## 完了条件

- 4 モジュールの異常系がテストで pin されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

4 モジュールに `*.test.ts` を新設し、異常系・境界値を固定した (16 件)。issue の参照は draft-20 の節番号だが、現在の一次資料 draft-ietf-moq-transport-21 の節番号でコメントを書いている。

### 追加したテスト

- `src/message/subscribe.test.ts` (3 件): SUBSCRIBE / REQUEST_UPDATE の末尾後続データ違反、offset 指定時の末尾判定
- `src/message/publish.test.ts` (4 件): PUBLISH_DONE の Reason Phrase が上限ちょうどなら通過 / 1 バイト超過で拒否、末尾後続データ違反、PUBLISH の Track Properties が残りバイトすべてとして読み戻されること
- `src/message/trackstatus.test.ts` (2 件): TRACK_STATUS の末尾後続データ違反、offset 指定時の末尾判定
- `src/message/namespace.test.ts` (7 件): PUBLISH_NAMESPACE / NAMESPACE / NAMESPACE_DONE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / PUBLISH_SKIPPED の末尾後続データ違反、空の Track Namespace Suffix が通過すること

### 役割分担

- 正常系の round-trip は既存の `*.prop.ts` (PBT) が担う
- Length 宣言の超過は既存の `src/message/decode-boundary.test.ts` が担う
- 本 issue では上記に含まれない「末尾後続データ」「Reason Phrase の上限境界」を担当し、重複を避けた

### 実装中に判明した点

`decodePublishPayload` には末尾後続データの検査が無い。これは draft-ietf-moq-transport-21 §9.8 で Track Properties が length プレフィックスを持たず Message の Length フィールドで終端が決まるためであり、意図的な非対称である。この契約をテストで固定した (残りバイトは Track Properties として解釈される)。

### 退行検出の裏付け

`decodeTrackStatusPayload` の末尾検査を一時的に無効化し、追加した 2 件が失敗することを実測した。検査は元に戻している。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 75 ファイル / 2,155 テスト全通過 (16 件増)
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
