# Track Namespace の 32 / 33 フィールド境界テストを追加する

- Created: 2026-09-08
- Completed: 2026-09-14
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

## 解決方法

テストを 3 件追加した。issue の参照は draft-20 の節番号だが、現在の一次資料 draft-ietf-moq-transport-21 では §2.4.1 (Track Naming) / §8.7 (Track Namespace Structure) / §9.20.21 (TRACK_NAMESPACE_PREFIX Parameter) に対応するため、コメントは draft-21 の節番号に合わせている。

### 追加したテスト

`src/message/parameter.test.ts` に追加した。

- 32 フィールド (`MAX_TRACK_NAMESPACE_FIELDS`) の Track Namespace が `encodeTrackNamespace` / `decodeTrackNamespace` をラウンドトリップし、消費バイト数がワイヤ長と一致すること。先頭のフィールド数 varint が上限値そのものであることも確認する
- 33 フィールドのデコードが `PROTOCOL_VIOLATION` で拒否されること (`track namespace fields exceeds maximum: 33 > 32`)
- TRACK_NAMESPACE_PREFIX (0x34) としての 32 フィールドが通過し、33 フィールドが同じ文言で拒否されること

`createTrackNamespace` は 33 フィールドを組み立てられない (送信側でも fail-fast で拒否する) ため、上限外のワイヤを作るヘルパー `buildTrackNamespaceWire(fieldCount)` をテスト内に置いた。

### 退行検出の裏付け

`MAX_TRACK_NAMESPACE_FIELDS` を一時的に 33 に変えて実行し、追加した 33 フィールドの 2 件と既存の `createTrackNamespace: 32 フィールドは成功し 33 フィールドはエラー` の計 3 件が失敗することを実測した。定数は元に戻している。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,133 テスト全通過 (3 件増)
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した (テスト追加のみで機能に影響しないため)
