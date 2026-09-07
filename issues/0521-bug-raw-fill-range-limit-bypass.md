# 手組み FILL_PARAMETERS 内側 Range が MAX_FILTER_RANGES 合算に入らない

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-raw-fill-range-limit
- Polished: YYYY-MM-DD

## 目的

手組みの raw FILL 内側 Range がピアの上限検証を素通りし、往復後の `INVALID_FILTER` 失敗や資源の過剰使用を招く。型付き fill 内側と同様に合算に含める必要がある。

## 現状

- `bidiSendRequestUpdate`（`src/session/bidi.ts`）の上限検証は `options.rangeFilters` と `options.fill` の Range のみを対象にし、`options.parameters` 由来（raw FILL 内側を含む）を数えない。
- 型付き fill 内側は購読単位の上限に含めるのに対し、raw FILL 内側は構文検証のみで素通りするため、構築経路によって適用範囲が変わる。
- §10.3.1.6 は購読単位の concurrent な全 Range Filter の Range 総数に上限を課す趣旨であり、構築経路で適用範囲が変わる規定はない。

## 設計方針

1. raw FILL 検証で得た内側 Range を合算に含めるか、少なくとも対象外である旨を説明に明記する。

## 完了条件

- raw FILL 内側 Range が上限検証に含まれる、または対象外が文書化されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.3.1.6 / §5.1.4 / §10.2.15
