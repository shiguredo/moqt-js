# Joining Fetch の forward state 不整合を request error として扱う

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Joining Fetch リクエストの forward 状態と SUBSCRIBE 側の forward 状態が
矛盾している場合に request error を返すと明示された。
moqt-js は既に `subscribe()` で forward=false 時の Joining Fetch 送信を事前に拒否しており、
受信側としての対応は不要。コメントを更新する。

## RFC 参照

draft-ietf-moq-transport-18 §10.12.2 (Joining Fetches):

> A Joining Fetch is only permitted when the associated subscription
> has Forward State 1; otherwise the publisher MUST respond with a
> REQUEST_ERROR with error code INVALID_RANGE.

draft-ietf-moq-transport-18 A.1: "Joining Fetch forward state mismatch is a request error (#1609)"

## 変更内容

1. `src/session.ts` の Joining Fetch バリデーションコードのコメントを draft-18 に更新する
2. 既存の forward=false 拒否コード (§10.12.2 準拠) の説明を draft-18 の文言に合わせる

## 該当ファイル

| ファイル         | 行番号    | 変更内容                                                            |
| ---------------- | --------- | ------------------------------------------------------------------- |
| `src/session.ts` | 1168-1178 | forward=false 時の Joining Fetch 拒否コメントを draft-18 に更新する |
| `src/session.ts` | 2090-2140 | `sendJoiningFetch` の JSDoc を draft-18 に更新する                  |

## 期待される動作

1. Joining Fetch 送信時に forward=false の場合、事前に Error が throw される (既存通り)
2. サーバーから INVALID_RANGE の REQUEST_ERROR が返った場合、`Fetcher.onError` に通知される (既存通り)

## テスト方針

- 既存テストの変更は不要 (forward=false + Joining Fetch の拒否は既にテスト済み)

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
