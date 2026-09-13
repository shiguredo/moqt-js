# 残る検証関数のコールバック API をエラー返却型に統一する

- Created: 2026-09-12
- Completed: 2026-09-14
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

## 解決方法

実装した。

### 返却型の統一

- `validateNoDuplicateGoawayOnRequestStream` (`src/session/bidi.ts`) を `(requestId, seenSet) => SessionError | null` に変更した。重複なしの場合は従来どおり `seenSet.add` して `null` を返し、重複の場合は PROTOCOL_VIOLATION の `SessionError` を返す。検証と `add` が同一の同期ブロックにある契約は維持している
- `incomingValidateRequestId` (`src/session/incoming.ts`) を `(requestId, receivedRequestIds) => SessionError | null` に変更した。パリティ違反・重複はそれぞれ INVALID_REQUEST_ID の `SessionError` を返す。拒否経路で return されるリクエストも Request ID を消費したものとして `add` する契約は維持している

`closeSession` コールバック引数と boolean 戻り値は両関数から完全に削除した。セッションを閉じるのは呼び出し側の責務になり、`validateParameterScope` / `validateRequestOkNoTrackProperties` / `namespaceValidateFirstMessage` と同じ形になった。

### 追随させた箇所

- `BidiSessionInternal.validateIncomingRequestId` (`src/session/bidi.ts`) の戻り値を `SessionError | null` にし、`SessionImpl.validateIncomingRequestId` (`src/session.ts`) は free function への純粋委譲にした (close 呼び出しを削除)
- 呼び出し 7 箇所 (`src/session/bidi.ts` 3 / `src/session.ts` 2 / `src/session/incoming.ts` 1 / `src/session/namespaceLoops.ts` 1) を「返却された `SessionError` を `closeWithError` に渡して return」に書き換えた
- テストのスタブ 4 箇所を `(): SessionError | null => null` に、`incomingValidateRequestId` を直接呼ぶ単体テスト 6 件と `validateNoDuplicateGoawayOnRequestStream` の単体テスト 2 件の期待値を返却値検証に更新した

### 処理順序

`close` してから return する順序、および `src/session/incoming.ts` の未対応リクエスト経路で「検証違反ならセッションを閉じて NOT_SUPPORTED 応答を送らない」順序は変えていない。テスト総数は 2,126 で変わらず、全通過する。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,126 テスト全通過
- `rg "closeSession" src/session/bidi.ts src/session/incoming.ts` の一致が 0 件であること
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
