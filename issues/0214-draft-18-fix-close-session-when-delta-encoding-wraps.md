# delta encoding がラップした場合にセッションを閉じる

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Fetch / Subgroup の delta encoding (Object ID delta, Group ID delta) が
varint 範囲を超えてラップアラウンドする場合、セッションを PROTOCOL_VIOLATION で閉じると明示された。
moqt-js は delta デコード時に累積値のラップ (prior + delta が prior より小さくなる場合) を
検出して `ProtocolViolationError` を throw する必要がある。

## RFC 参照

draft-ietf-moq-transport-18 §11.4.2 (Subgroup Header) / §11.4.4 (Fetch Header):

> The delta value MUST NOT cause the accumulated value to wrap around
> (exceed the varint range). If a receiver detects a wrapped delta value,
> it MUST close the session with a PROTOCOL_VIOLATION.

draft-ietf-moq-transport-18 A.1: "Close session when delta encoding wraps (#1560)"

## 変更内容

1. `src/dataStream.ts` の `decodeObjectFields` で Object ID Delta の累積値がラップする場合に `ProtocolViolationError` を throw する
2. `src/dataStream.ts` の `decodeFetchObjectFields` で Group ID / Object ID / Subgroup ID の delta 累積値がラップする場合に `ProtocolViolationError` を throw する
3. `src/session.ts` の `processSubgroupObjects` / `processFetchObjects` で `ProtocolViolationError` を catch してセッションを閉じる

## 該当ファイル

| ファイル | 行番号 | 変更内容 |
| --- | --- | --- |
| `src/dataStream.ts` | 381-437 | `decodeObjectFields` で delta 累積値のラップ検出を追加する |
| `src/dataStream.ts` | 1120-1253 | `decodeFetchObjectFields` で Group ID / Object ID / Subgroup ID の delta ラップ検出を追加する |
| `src/session.ts` | `processSubgroupObjects` | `ProtocolViolationError` の catch 時にセッションを閉じる (既存の catch 経路を確認) |
| `src/session.ts` | `processFetchObjects` | `ProtocolViolationError` の catch 時にセッションを閉じる (既存の catch 経路を確認) |

## 期待される動作

1. Subgroup stream で Object ID delta が [0, prior + 1] に収まらなくなり varint 範囲を超える場合、`ProtocolViolationError` を throw する
2. Fetch stream で Group ID / Object ID の delta 累積が varint 範囲を超える場合、`ProtocolViolationError` を throw する
3. `ProtocolViolationError` は受信ループで catch され、`PROTOCOL_VIOLATION` でセッションが閉じられる
4. 正常な delta 値の処理は従来通り

## テスト方針

- `src/dataStream.test.ts` に delta ラップ検出の単体テストを追加する:
  - `decodeObjectFields` で prior が大きい値で delta が varint 最大を超える場合のテスト
  - `decodeFetchObjectFields` で各フィールドのラップ検出テスト
- `src/message/fetch.prop.ts` の PBT でラップする可能性がある delta 値を含め、`ProtocolViolationError` が throw されることを検証する

## 影響範囲

- 実装変更あり
- 後方互換あり (既存の正常値の処理は変わらない。異常系のプロトコル違反検出が追加される)
- 既存の `ProtocolViolationError` を catch してセッションを閉じる経路が再利用できる
