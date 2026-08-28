# AbsoluteRange の End Group が 2^64-1 を超える場合の検証がない

- Created: 2026-08-22
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-absoluterange-end-group-overflow
- Polished: 2026-08-28

## 目的

draft-ietf-moq-transport-19 §5.1.2 の「If the resulting Group ID would be greater than 2^64 - 1, the endpoint MUST close the session with a PROTOCOL_VIOLATION.」という MUST を満たす検証が未実装である。AbsoluteRange フィルタの End Group（Start Location の Group + End Group Delta）が 2^64-1 を超えた場合に、仕様どおり PROTOCOL_VIOLATION で拒否する。

## 現状

- `decodeLocationFilter()`（`src/message/parameter.ts`）は AbsoluteRange の Start Location + End Group Delta が 2^64-1 を超えていても検証せずに受理する。受信した SUBSCRIBE / FETCH / REQUEST_UPDATE の不正な AbsoluteRange がそのまま通過し、§5.1.2 の MUST（PROTOCOL_VIOLATION でセッションを閉じる）に反する。
- `encodeLocationFilter()`（`src/message/parameter.ts`）にも送信前検証が無く、2^64-1 を超える AbsoluteRange をそのまま送信してしまう。
- `resolveFilter()`（`src/filter.ts`）は AbsoluteRange で `start.group + endGroupDelta` を無検証のまま計算する（bigint のためオーバーフローはしない）。上流のデコード段階で 2^64-1 超過が拒否されないと、仕様外の End Group がフィルタ解決へ流れ込み、後続のマッチング動作の前提が壊れる。
- `MAX_VARINT`（2^64-1）は `src/varint.ts` で export 済みであり、`src/message/parameter.ts` の Range Filter の 2^64-1 超過検証（`InvalidFilterError`）でも利用されている。
- `InvalidFilterError`（`src/error.ts`）の doc comment は現状「不正な Range Filter (§5.1.3 / §10.2.12-14)」に限定されており、Location Filter は対象外である。

## 設計方針

- 受信経路のデコード（`decodeLocationFilter`）で Start Location の Group + End Group Delta を検証し、2^64-1 超過は `ProtocolViolationError` を throw する。§5.1.2 の MUST は PROTOCOL_VIOLATION 一択であり、INVALID_FILTER 応答パスは存在しないため `InvalidFilterError` は使わない。
- 送信前にも駆動経路（`encodeLocationFilter` / `encodeLocationFilterParameter`）で同一規則を適用し、2^64-1 超過のフィルタは `InvalidFilterError` を throw する（既存の Range Filter 送信前検証と同じ流儀）。あわせて `InvalidFilterError` の doc comment を「Range Filter および Location Filter」に拡張する。
- 検証は `MAX_VARINT`（`src/varint.ts`）を使って行う。
- `resolveFilter()` の AbsoluteRange はデコード段階で 2^64-1 超過が拒否されていることを前提とし、フィルタ解決処理に重複した検証を持ち込まない。

## 完了条件

- `start.group + endGroupDelta > 2^64-1` の AbsoluteRange を含む受信メッセージが PROTOCOL_VIOLATION で拒否されること（デコードの単体テスト、可能なら受信処理の結合テストで検証する）。
- 送信側で 2^64-1 超過の AbsoluteRange が throw されること（エンコードの単体テストで検証する）。
- 境界値 (`2^64-1` ちょうど) は受理されること。
- `vp lint` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1.2 (Location Filters)

## 解決方法

未着手。
