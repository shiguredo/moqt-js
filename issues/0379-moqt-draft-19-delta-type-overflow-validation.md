# Key-Value-Pair / Message Parameter の Delta Type 加算の 2^64-1 超過検証がない

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-delta-type-overflow-validation
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §1.4.3 の「The previous Type value plus the Delta Type MUST NOT be greater than 2^64 - 1. If a Delta Type is received that would be too large, the Session MUST be closed with a PROTOCOL_VIOLATION.」と §10.2 の同要件を満たす。現在は `previousType + deltaType` の 2^64-1 超過チェックがなく、JS number 化による精度劣化も発生しうる。

## 優先度根拠

Message Parameter / Track Property のデコードで Delta Type を加算する際、2^64-1 を超える Type が生成されても検出されない。悪意のあるピアからの不正ワイヤを検出できない MUST 違反。Medium。

## 現状

- `src/message/parameter.ts:489-495` (`decodeKeyValuePair`) で `paramType = previousType + Number(deltaType)` としており、2^64-1 超過の明示チェックがない。
- `src/message/parameter.ts:700-701` (`decodeMessageParameter`) も同様。
- `src/properties.ts` の全デコード経路 (`decodeProperties` / `parseProperties` / `decodeImmutableProperties` / `decodeObjectPropertiesTolerant`) も `previousId + deltaId` の 2^64-1 超過チェックがない。

## 設計方針

- 各デコード経路で加算前に 2^64-1 超過を検証し、超過時は ProtocolViolationError を送出する。
- JS number で扱っている箇所は bigint 演算に統一し、精度劣化も解消する。
- 固定バイト列で「加算結果が 2^64-1 を超える Delta Type」を検証するテストを追加する。

## 完了条件

- 加算結果が 2^64-1 を超える Delta Type を受信した場合に PROTOCOL_VIOLATION でセッションが閉じること。
- `src/message/parameter.ts` と `src/properties.ts` の全デコード経路で検証されること。
- 上記を検証する固定バイト列テストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §1.4.3 (Key-Value-Pair Structure)
- draft-ietf-moq-transport-19 §10.2 (Message Parameters)

## 解決方法

未着手。
