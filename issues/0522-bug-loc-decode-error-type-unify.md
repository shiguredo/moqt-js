# LOC 単体デコーダの前段 varint 不完全のエラー型を統一する

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-loc-decode-error-type
- Polished: YYYY-MM-DD

## 目的

単体デコーダの前段 varint 切断で `IncompleteDataError` が漏れ、同一現象の切り詰めでも切断位置でエラー型が割れる。単体デコーダ間の方針を統一する必要がある。

## 現状

- `src/loc.ts` の `decodeVideoConfig` と `decodeAudioConfig` は Length 確定後の Value 不足を `ProtocolViolationError` で送出するが、ID / Length の varint 自体が不完全な入力では `decodeVarint` の `IncompleteDataError` がそのまま漏れる。
- `decodeVideoFrameMarkingAfterId`（`src/loc.ts`）も前段 varint の `IncompleteDataError` を変換しないため、単体デコーダ間で前段の扱いが割れている。
- 対照的に `decodeLocObjectPayload`（`src/loc.ts`）は `IncompleteDataError` を捕捉して `ProtocolViolationError` に変換し、外向けに漏らさない方針を明記している。

## 設計方針

1. 単体デコーダの前段 varint の `IncompleteDataError` を `ProtocolViolationError` に変換するか、少なくとも呼び出し側の契約として文書化する。変換する場合は `decodeVideoFrameMarkingAfterId` を含めて統一する。

## 完了条件

- 前段 varint 不完全の扱いが単体デコーダ間で統一される、または契約として文書化されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-loc-04 §2.3.2 / §2.3.3
