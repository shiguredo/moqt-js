# LOC 単体デコーダの前段 varint 不完全のエラー型を統一する

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-loc-decode-error-type
- Polished: 2026-09-08

## 目的

単体デコーダの前段 varint 切断で `IncompleteDataError` が漏れ、同一現象の切り詰めでも切断位置でエラー型が割れる。単体デコーダ間の方針を統一する必要がある。

## 現状

- `src/loc.ts` の `decodeVideoConfig` と `decodeAudioConfig` は Length 確定後の Value 不足を `ProtocolViolationError` で送出するが、ID / Length の varint 自体が不完全な入力では `decodeVarint` の `IncompleteDataError` がそのまま漏れる。
- `decodeVideoFrameMarkingAfterId`（`src/loc.ts`）も前段 varint の `IncompleteDataError` を変換しないため、単体デコーダ間で前段の扱いが割れている。公開関数の `decodeVideoFrameMarking` 本体の ID 側も同型である。
- 同型の漏れは `decodeTimestamp`、`decodeTimescale`、`decodeAudioLevel`（いずれも `src/loc.ts`）にもある。
- 対照的に `decodeLocObjectPayload`（`src/loc.ts`）は `IncompleteDataError` を捕捉して `ProtocolViolationError` に変換し、外向けに漏らさない方針を明記している。

## 設計方針

1. 単体デコーダの前段 varint の `IncompleteDataError` を `ProtocolViolationError` に変換し、`decodeLocObjectPayload` と同一方針に統一する。対象は `decodeVideoConfig`、`decodeAudioConfig`、`decodeVideoFrameMarking`（内部の `decodeVideoFrameMarkingAfterId` を含む）、`decodeTimestamp`、`decodeTimescale`、`decodeAudioLevel` とする。なお `0466-bug-loc-config-decode-truncation` は前段 varint 不完全を `IncompleteDataError` のまま残す決定で closed しているため、本 issue はその決定を覆す。再検討の理由は切断位置によるエラー型の割れ（同一の切り詰めでも Value 不足と ID / Length 不足で型が変わる）の解消である。`0492-bug-loc-decoder-robustness` と同一コードを触るため、`0492` の完了後に着手し、`0492` の契約前提を更新する。

## 完了条件

- 前段 varint 不完全の扱いが単体デコーダ間で `ProtocolViolationError` に統一されること。
- `src/loc.test.ts` の前段不完全を `IncompleteDataError` で期待する既存テストと、`src/loc.ts` の `@throws IncompleteDataError` の JSDoc を更新すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-loc-04 §2.3.2.1 / §2.3.2.2 / §2.3.3.1（形式のみを定め、エラー型は定めない。エラー型選択は `decodeLocObjectPayload` と同趣旨のリポジトリ判断である）
- `0466-bug-loc-config-decode-truncation`（前段不完全を残す決定。本 issue で覆す）
- `0492-bug-loc-decoder-robustness`（同一コードを触るため完了後に着手）
