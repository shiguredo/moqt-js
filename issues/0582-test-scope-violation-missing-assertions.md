# スコープ違反テストの同一性・順序・メッセージ検証を全経路で揃える

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/test-scope-violation-missing-assertions
- Polished: {YYYY-MM-DD}

## 目的

スコープ違反のテストは経路ごとに検証内容が異なり、PUBLISH_OK / PUBLISH_STATE_NOTIFY / PUBLISH は reject と close の同一オブジェクト性・順序・エラーメッセージを検証していない。SUBSCRIBE_OK / FETCH_OK / TRACK_STATUS_OK / REQUEST_UPDATE_OK と揃え、不変条件の回帰検知を強化する。

## 現状

- PUBLISH_OK のスコープ違反テストは `rejected()` / `closedWithError()` の存在と code のみを検証し、同一オブジェクト性・順序・メッセージを検証していない。
- PUBLISH_STATE_NOTIFY のテストは code のみを検証し、メッセージを検証していない。
- 受信 PUBLISH のテストは `sessionState === "closed"` のみを検証し、code とメッセージを検証していない。
- 一方、SUBSCRIBE_OK (`strictEqual` + `deepEqual(order, ["reject", "close"])`) や REQUEST_UPDATE_OK は同一性・順序まで検証している。

## 設計方針

1. PUBLISH_OK のテストコンテキストに reject / close の順序記録を追加し、同一オブジェクト性と順序を検証する。
2. PUBLISH_STATE_NOTIFY / PUBLISH のテストに code とメッセージの検証を追加する。
3. スイート全体で「スコープ違反の reject / close の検証内容」を揃え、経路ごとの非対称をなくす。

## 完了条件

- PUBLISH_OK / PUBLISH_STATE_NOTIFY / PUBLISH のスコープ違反テストが、同一オブジェクト性・順序・メッセージを検証していること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `bidiReadPublishResponse` / `bidiHandlePublishStateNotify` (`src/session/bidi.ts`)
- PUBLISH 受信経路 (`src/session.ts`)
- 既存テスト (`src/session/bidi.test.ts` / `src/session.test.ts`)
- `issues/closed/0523-refactor-namespace-validation-error.md`
