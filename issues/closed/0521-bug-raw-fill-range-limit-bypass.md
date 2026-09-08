# 手組み FILL_PARAMETERS 内側 Range が MAX_FILTER_RANGES 合算に入らない

- Created: 2026-09-07
- Completed: 2026-09-08
- Branch: feature/fix-raw-fill-range-limit
- Polished: 2026-09-08

## 目的

手組みの raw FILL 内側 Range がピアの上限検証を素通りし、往復後の `INVALID_FILTER` 失敗を招く。型付き fill 内側と同様に合算に含める必要がある。

## 現状

- `bidiSendRequestUpdate`（`src/session/bidi.ts`）の上限検証は `options.rangeFilters` と `options.fill` の Range のみを対象にし、`options.parameters` 由来（raw FILL 内側を含む）を数えない。
- 型付き fill 内側は購読単位の上限に含めるのに対し、raw FILL 内側は構文検証のみで素通りするため、構築経路によって適用範囲が変わる。
- 型付き現行実装との一貫性のため、raw 内側も同一の合算対象にする。仕様の §10.3.1.6（購読または fetch 単位の concurrent 上限）と §10.2.15（FILL は運んだメッセージにのみ適用）のみからは内側の合算先は確定しないため、本 issue の根拠は現行実装との一貫性に置く。

## 設計方針

1. raw FILL 検証で得た内側 Range を合算に含める。`decodeFillParameters` の戻り値のうち内側 Range Filter（0x25-0x28）を `decodeRangeFilter` で `RangeFilterSpec` 化し、当該メッセージ分の `newFillRanges` に加える。ガード進入条件は raw 由来も含めて判定し、raw のみの要求でも検証に入るようにする。`pendingRequestUpdate` の `fillRangeFilters` に raw 由来も保持し、`inFlightFillRangeFilters` の合算に含める。順序は `0520-bug-fill-duplicate-send-guard` の重複検査を先に行い、重複入力は上限合算の対象にしない。

## 完了条件

- raw FILL 内側 Range が上限検証（当該メッセージ分と in-flight 合算）に含まれ、超過時は送信前に拒否され `pendingRequestUpdate` に entry が残らないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- `src/session/bidi.ts` に `prepareRawFillForUpdate` を追加し、重複検査・内側検証・上限合算用の内側 Range 取り出しをまとめて上限検証より前に行う。型付き fill 内側と合算し、`pendingRequestUpdate` に保持して in-flight 合算に含める
- `rangeFilterTypeOf` を `src/message` から再 export し、内側 Range の `RangeFilterSpec` 化に使う (公開 API への漏れなし)
- `src/session/bidi.test.ts` に超過・in-flight 双方向・上限以内のテスト 6 件を追加した。複数件内側検証テストは重複先行に合わせて単一版に更新した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 関連

- draft-ietf-moq-transport-20 §10.3.1.6 / §5.1.4 / §10.2.15
