# AbsoluteRange の End Group が 2^64-1 を超える場合の検証がない

- Created: 2026-08-22
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-absoluterange-end-group-overflow
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §5.1.2 の「If the resulting Group ID would be greater than 2^64 - 1, the endpoint MUST close the session with a PROTOCOL_VIOLATION.」という MUST を満たす検証が未実装である。AbsoluteRange フィルタの End Group（Start Location の Group + End Group Delta）が 2^64-1 を超えた場合に、仕様どおり PROTOCOL_VIOLATION で拒否する。

## 現状

- `resolveFilter()`（`src/filter.ts`）は AbsoluteRange で `start.group + endGroupDelta` を無検証で計算する。bigint のためオーバーフローはしないが、結果として End Group 制限が 2^64-1 の仮想世界を越えた値になり、仕様の MUST に反する。
- `decodeLocationFilter()`（`src/message/parameter.ts`）にも同様の検証が無く、受信した SUBSCRIBE / FETCH / REQUEST_UPDATE の不正な AbsoluteRange をそのまま受理する。
- `encodeLocationFilter()`（`src/message/parameter.ts`）にも送信前検証が無い。
- `MAX_VARINT`（2^64-1）は `src/varint.ts` で export 済みであり、`src/message/parameter.ts` の Range Filter の 2^64-1 超過検証（`InvalidFilterError`）でも利用されている。

## 設計方針

- 受信経路のデコード（`decodeLocationFilter`）で Start Location の Group + End Group Delta を検証し、2^64-1 超過は PROTOCOL_VIOLATION で拒否する（§5.1.2 の MUST どおりセッションを閉じる）。
- 送信前にも駆動経路（`encodeLocationFilter` / `encodeLocationFilterParameter`）で同一規則を適用し、2^64-1 超過のフィルタは送信を拒否する（既存の Range Filter 送信前検証と同じ流儀）。
- 検証は `MAX_VARINT`（`src/varint.ts`）を使って行う。
- `resolveFilter()` の AbsoluteRange はデコード済みであることを前提とする（デコード段階で保証されれば、フィルタ解決処理に重複した検証を持ち込まない）。

## 完了条件

- `start.group + endGroupDelta > 2^64-1` の AbsoluteRange を含む受信メッセージが PROTOCOL_VIOLATION で拒否されること（デコードの単体テスト、可能なら受信処理の結合テストで検証する）。
- 送信側で 2^64-1 超過の AbsoluteRange が throw されること（エンコードの単体テストで検証する）。
- 境界値 (`2^64-1` ちょうど) は受理されること。
- `vp lint` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1.2 (Location Filters)

## 解決方法

未着手。
