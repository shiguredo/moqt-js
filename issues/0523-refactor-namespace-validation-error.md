# namespace 系検証の到達不能フォールバック分岐の複製を解消する

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/refactor-namespace-validation-error
- Polished: YYYY-MM-DD

## 目的

違反時に必ずコールバックを呼ぶ検証関数の呼び出し側 5 箇所で、実質到達不能なフォールバック生成を複製している。検証関数がエラーを返す形に切り出して複製をなくす必要がある。

## 現状

- `src/session/namespaceLoops.ts` の初期応答検証 5 箇所（namespace / tracks / publication のスコープ検証と namespace / publication の Track 空検証）は `scopeError ?? new SessionError(...)` 形のフォールバックを持つ。
- `validateParameterScope`（`src/message/parameterScope.ts`）と `validateRequestOkNoTrackProperties`（`src/session/bidi.ts`）は違反時に必ずコールバックを呼ぶため、フォールバックは実質到達不能な防御分岐である。
- PUBLISH 応答経路（`src/session/bidi.ts` の発行待ち処理）も同形のフォールバックを持つため、切り出し時は両経路の扱いを揃える必要がある。

## 設計方針

1. 検証関数がエラーを返す形（成功時は null 等）に切り出し、呼び出し側のフォールバック複製をなくす。PUBLISH 経路と namespace 系の両方に適用する。

## 完了条件

- 到達不能フォールバックの複製がなくなること。
- 検証失敗時の reject と close の順序・同一オブジェクト性が変わらないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.2.1 / §10.5
