# Track Namespace の 32 / 33 フィールド境界テストを追加する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/add-track-namespace-fields-boundary-test
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §2.4.1 のフィールド数上限 32 の境界（32 は許可、33 は PROTOCOL_VIOLATION）を回帰検出できるようにする。受信側 `decodeTrackNamespace` の検証は実装済みだが、境界値を直接検証するテストが無い。

## 現状

- `src/message/parameter.ts` の `decodeTrackNamespace` は `MAX_TRACK_NAMESPACE_FIELDS` (32) 超過を検証するが、32 / 33 フィールドの境界を検証するテストが無い。
- PBT の `trackNamespaceParameterArb`（`parameter.prop.ts` / `subscribe.prop.ts`）は `maxLength: 5` のため上限付近を生成しない。

## 設計方針

1. 32 フィールドの Track Namespace が encode / decode でラウンドトリップするテストを追加する。
2. 33 フィールドのデコードが `ProtocolViolationError` になるテストを追加する。
3. 32 / 33 フィールドを 0x34 パラメータとしてデコードするケースも検証する。

## 完了条件

- 32 フィールドは成功、33 フィールドは拒否されるテストが通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §2.4.1 / §10.2.20
- `decodeTrackNamespace` / `MAX_TRACK_NAMESPACE_FIELDS`
- `trackNamespaceParameterArb`
