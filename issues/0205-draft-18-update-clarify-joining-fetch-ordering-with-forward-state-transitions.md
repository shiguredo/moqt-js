# Joining Fetch と forward state 遷移の順序を明確化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Joining Fetch と SUBSCRIBE の forward state 遷移との
処理順序 (forward 0→1 遷移時の Joining Fetch 開始タイミング、
REQ_UEST_UPDATE の処理順序) が明確化された。
moqt-js の Joining Fetch 発行タイミングと SUBSCRIBE 状態の関係を確認し、
コメントを更新する。

## RFC 参照

draft-ietf-moq-transport-18 §10.12.2 (Joining Fetches):

> A publisher MUST process any pending REQUEST_UPDATE messages for
> the associated subscription before evaluating the current request.

draft-ietf-moq-transport-18 §5.1.3 (Joining an Ongoing Track):

> The Joining Location is established when the subscription's Forward
> State transitions from 0 to 1, and a publisher MUST save the
> Largest Location communicated in SUBSCRIBE_OK, PUBLISH or
> REQUEST_UPDATE_OK that changes the Forward State from 0 to 1.

draft-ietf-moq-transport-18 A.1: "Clarify Joining Fetch ordering with Forward State transitions (#1577)"

## 変更内容

1. `src/session.ts` の `sendJoiningFetch` メソッドの JSDoc に forward 遷移の順序に関する説明を追記する
2. `src/session.ts` の `subscribe()` メソッドの JSDoc に Joining Location の確立タイミング (forward 0→1 時) を追記する

## 該当ファイル

| ファイル | 行番号 | 変更内容 |
| --- | --- | --- |
| `src/session.ts` | 295-310 | `JoiningFetchOptions` の JSDoc に forward 遷移順序の説明を追記する |
| `src/session.ts` | 1168-1188 | `subscribe()` の Joining Fetch 関連コメントに pending REQUEST_UPDATE の処理順序を追記する |
| `src/session.ts` | 2090-2140 | `sendJoiningFetch` の JSDoc に Joining Location 確立タイミングを追記する |

## 期待される動作

1. SUBSCRIBE の forward が 0→1 に遷移するとき、その SUBSCRIBE_OK / REQUEST_UPDATE_OK に含まれる Largest Location が Joining Location として保存される
2. Joining Fetch は Joining Location を基準に範囲を計算する
3. サーバー側では pending の REQUEST_UPDATE を Joining Fetch より先に処理する

## テスト方針

- 既存テストの変更は不要
- コメント更新のみのためテスト対象外

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
