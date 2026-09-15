# Object Properties の Length 上限と Delta overflow を検証しない

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-object-properties-length-and-delta
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §8.3 の Key-Value-Pair はデータプレーンにも適用される。Delta Type の累積が 2^64-1 を超える場合と、奇数 Type の Length が 2^16-1 を超える場合にセッションを閉じる MUST が定められているが、Object Properties 経路はどちらも検証しない。壊れた・悪意あるピアに対して仕様が要求するセッション終了を行えない。

## 現状

- `decodeObjectPropertiesTolerant` と `assertKnownPropertyValueInObjectProperties` (`src/properties.ts`) は、delta の累積上限と Length 上限を検査しない
- `decodeProperties` / `parseProperties` / `decodeImmutableProperties` はどちらも検査しており、Track Properties と Object Properties で非対称
- 呼び出し元は Object Datagram / Subgroup Object / Fetch Object の 3 経路
- 上限超過でも宣言 Length が残りバイト内に収まっていれば素通りする
- 既知 Type の Length が残りバイトを超える場合は KEY_VALUE_FORMATTING_ERROR になるが、上限超過は対象外

draft-ietf-moq-transport-21 §8.3:

> The previous Type value plus the Delta Type MUST NOT be greater than 2^64 - 1. If a Delta Type is received that would be too large, the Session MUST be closed with a PROTOCOL_VIOLATION.

> Length: Only present when Type is odd. Specifies the length of the Value field in bytes. The maximum length of a value is 2^16-1 bytes. If an endpoint receives a length larger than the maximum, it MUST close the session with a PROTOCOL_VIOLATION.

## 設計方針

- 厳密デコーダと同じ判定を共有し、Object Properties 経路でも上限超過を PROTOCOL_VIOLATION にする
- 寛容デコードの契約 (不完全データでは読めた分だけ返す) は維持する。上限超過は「不完全データ」ではなく仕様違反として区別する
- 3 経路から共通の検証を呼び、経路ごとの検証漏れを作らない

## 完了条件

- Object Properties で delta の累積が 2^64-1 を超えると PROTOCOL_VIOLATION になる
- Object Properties で奇数 Type の Length が 2^16-1 を超えると PROTOCOL_VIOLATION になる
- Object Datagram / Subgroup Object / Fetch Object の 3 経路すべてで検証される
- 不完全データの寛容な打ち切りは従来どおり
- テストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §8.3 (Key-Value-Pair Structure)
- draft-ietf-moq-transport-21 §8.4 (Track and Object Properties)
- draft-ietf-moq-transport-21 §11.1.3 (Object Properties)
