# delivery timeout または STOP_SENDING 後に Subgroup を再オープンしてはならない (§10.4.2) 検証が未実装

Created: 2026-05-13
Model: Opus 4.7

## 概要

`src/session.ts:828-838` に TODO として残っている Subgroup 再オープン禁止の検証が未実装である。

```typescript
// TODO: Closed Subgroup Tracking
// draft-ietf-moq-transport-17:
// delivery timeout または STOP_SENDING 後に Subgroup を再オープンしてはならない。
// draft-ietf-moq-transport-17 Section 10.4.2
//
// 現在の実装では 1 Group = 1 Subgroup = 1 Stream モデルを採用しているため、
// グループが終了すると自然と新しいストリームを作成する。
// 完全な実装には以下が必要:
// 1. WebTransport の STOP_SENDING シグナル検出
// 2. 閉じた Subgroup (trackAlias, groupId, subgroupId) の追跡
// 3. sendObject 時に閉じた Subgroup への送信を拒否
```

## 一次資料の引用

draft-ietf-moq-transport-17 §10.4.2:

> A publisher MUST NOT open a subgroup that has been previously closed due to
> a delivery timeout or STOP_SENDING from the subscriber.

## 期待される動作

1. Publisher の各送信ストリームで STOP_SENDING (WebTransport の `stream.readable.cancel()` 相当) を検出する
2. 閉じた Subgroup を `(trackAlias, groupId, subgroupId)` のタプルで追跡する
3. `sendObjectInternal()` で追跡中の Subgroup への送信を拒否する

## 実装方針

1. `SessionImpl` に `closedSubgroups: Set<string>` を追加し、キーは `"${trackAlias}:${groupId}:${subgroupId}"` 形式
2. `handleSubgroupStream` で STOP_SENDING / delivery timeout 検出時に closedSubgroups に追加
3. `sendObjectInternal` 冒頭で closedSubgroups をチェックし、該当すれば Error を throw

## 影響範囲

- `src/session.ts`: `closedSubgroups` 管理、`sendObjectInternal` / `handleSubgroupStream` へのガード追加
- `src/publisher.ts`: 必要に応じてエラー伝搬経路の確認

## テスト戦略

- `sendObject` で閉じた Subgroup に送信した場合に Error が throw されること
- `sendObject` で異なる Subgroup には送信できること

## ブランチ命名

`feature/fix-` を使う。

## 完了条件

- TODO コメントが削除され、実装で置き換えられている
- `sendObjectInternal` で閉じた Subgroup への送信を拒否する
- `vp run test` 全パス
- `vp run build` 成功
