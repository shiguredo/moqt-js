# 残る検証関数のコールバック API をエラー返却型に統一する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-validation-functions-unify
- Polished: {YYYY-MM-DD}

## 目的

`validateNoDuplicateGoawayOnRequestStream` と `incomingValidateRequestId` は依然として `closeSession` コールバックを受け取り boolean を返す。エラー返却型 (`SessionError | null`) に統一し、検証関数 API の非対称を解消する。

## 現状

- `validateNoDuplicateGoawayOnRequestStream` (`src/session/bidi.ts`) は `(requestId, seenSet, closeSession) => boolean` で、検証成功時に `seenSet.add` する副作用を持つ。呼び出しは 4 箇所である。
- `incomingValidateRequestId` (`src/session/incoming.ts`) は `(requestId, closeSession) => boolean` で、`BidiSessionInternal.validateIncomingRequestId` インターフェースと `SessionImpl` のメソッド、テストのスタブを経由する。
- `validateParameterScope` / `validateRequestOkNoTrackProperties` / `namespaceValidateFirstMessage` は `SessionError | null` 返却に統一済みである。

## 設計方針

1. 両関数を `SessionError | null` 返却に変更し、コールバック引数と boolean 戻り値を削除する。`seenSet.add` の副作用は現行の契約 (null なら add 済み) を維持するか、呼び出し側へ分離するかを判断する。
2. `BidiSessionInternal.validateIncomingRequestId` と `SessionImpl` のメソッド、テストのスタブを追随させる。
3. 呼び出し側は返却された `SessionError` で close する。close 後に応答を送る経路 (`src/session/incoming.ts`) の処理順序を変えない。

## 完了条件

- 両関数が `SessionError | null` を返し、旧コールバック API と boolean 戻り値が残っていないこと。
- 検証失敗時の close 挙動・処理順序が変わらないこと。
- 既存テストが全て通り、`vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `### misc` に `[UPDATE]` を追加すること。

## 関連

- `validateNoDuplicateGoawayOnRequestStream` (`src/session/bidi.ts`) / `incomingValidateRequestId` (`src/session/incoming.ts`) / `validateIncomingRequestId` (`src/session.ts`)
- `issues/closed/0523-refactor-namespace-validation-error.md` (先行の統一)
