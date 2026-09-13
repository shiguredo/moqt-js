# スコープ違反テストの同一性・順序・メッセージ検証を全経路で揃える

- Created: 2026-09-12
- Completed: 2026-09-14
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

## 解決方法

テストの検証内容を強化した。判定の実装は変えていない。

### PUBLISH_OK

`createPublishOkValidationContext` (`src/session/bidi.test.ts`) に `order: string[]` を追加し、`reject` / `closeWithError` の呼び出し順を記録するようにした。2 件のテスト (End Group 超過の LOCATION_FILTER / 正常値の LOCATION_FILTER) に次を追加した。

- `assert.strictEqual(ctx.rejected(), ctx.closedWithError())` による同一オブジェクト性
- `assert.deepEqual(ctx.order, ["reject", "close"])` による順序 (実装は削除・reject・close の順で、先に close すると汎用エラーで上書きされるため)
- メッセージに `parameter type 0x21 not allowed in PUBLISH_OK` を含むこと

### PUBLISH_STATE_NOTIFY

`src/session/bidi.test.ts` の許可外パラメータのテストに `parameter type 0x20 not allowed in PUBLISH_STATE_NOTIFY` のメッセージ検証を追加した。`src/session.test.ts` の受信 PUBLISH ストリーム上の PUBLISH_STATE_NOTIFY のテストは `sessionState === "closed"` だけを検証していたため、`ConnectCallbacks.error` を注入して code (PROTOCOL_VIOLATION) とメッセージを検証するようにした。

### 受信 PUBLISH

`受信 PUBLISH の許可外パラメータでセッションが閉じる` (`src/session.test.ts`) は `sessionState === "closed"` のみだったため、同じく `error` コールバックを注入し、3 種の許可外パラメータ (NEW_GROUP_REQUEST / SUBGROUP_FILTER / FILL_PARAMETERS) それぞれで code と `not allowed in PUBLISH` を含むメッセージを検証するようにした。

### 揃えた結果

SUBSCRIBE_OK / FETCH_OK / TRACK_STATUS_OK / REQUEST_UPDATE_OK が既に持っていた「同一オブジェクト性 + 順序 + code + メッセージ」の検証内容に、PUBLISH_OK / PUBLISH_STATE_NOTIFY / 受信 PUBLISH も揃った。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,130 テスト全通過 (テスト総数は変わらず、検証内容のみ強化)
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
