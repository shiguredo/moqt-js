# 検証関数のコールバック API をエラー返却に変えて到達不能フォールバックの複製を解消する

- Created: 2026-09-07
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-namespace-validation-error
- Polished: 2026-09-12

## 目的

違反時に必ずコールバックを呼ぶ検証関数の呼び出し側で、実質到達不能なフォールバック生成を複製している。検証関数がエラーを返す形に切り出して複製をなくし、後続の共通化 (0498 / 0577) が前提とする API を確定させる。

## 現状

- フォールバック式 (`scopeError ?? new SessionError(...)` / `trackPropertiesError ?? new SessionError(...)`) は現行コードに 10 箇所ある。
  - `src/session/namespaceLoops.ts` の 4 箇所: `namespaceValidateInitialOk` の scope 検証と Track Properties 空検証、`namespaceStartPublicationStreamLoop` の REQUEST_OK 分岐の scope 検証と Track Properties 空検証。
  - `src/session/bidi.ts` の 6 箇所: `bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse` の scope 検証、`bidiHandleRequestUpdateOk` の scope 検証と Track Properties 空検証。
- `validateParameterScope` (`src/message/parameterScope.ts`) と `validateRequestOkNoTrackProperties` (`src/session/bidi.ts`) は違反時に必ず `closeSession` コールバックを呼んでから false を返すため、フォールバックの右辺は実質到達不能な防御分岐である。
- 検証関数の現在の呼び出し元 (テストを除く) は、`validateParameterScope` が 12 箇所 (`src/session/bidi.ts` 8 / `src/session/namespaceLoops.ts` 3 / `src/session.ts` 1)、`validateRequestOkNoTrackProperties` が 4 箇所 (`src/session/bidi.ts` 1 / `src/session/namespaceLoops.ts` 3)。テストは `src/message/parameterScope.test.ts` がコールバック契約で 12 回呼ぶ。
- 関連する一次資料は draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope) / §9.3 (REQUEST_OK の Track Properties) である。

## 設計方針

1. `validateParameterScope` を `(params, allowed, contextName) => SessionError | null` に、`validateRequestOkNoTrackProperties` を `(trackProperties, contextName) => SessionError | null` に変更する。コールバック引数と boolean 戻り値は削除し、旧シグネチャは残さない。
2. 呼び出し側は返却された `SessionError` を、既存と同じ順序 (削除 → reject → close) と同一オブジェクトで reject / `closeWithError` に渡す。フォールバック式は削除する。
3. 全呼び出し元 (`src/session/bidi.ts` / `src/session/namespaceLoops.ts` / `src/session.ts`) を新 API に追随させる。テストは `shiguredo-typescript` の「変更する場合はテストを先に修正する」に従い、`src/message/parameterScope.test.ts` を返却値検証に先に修正する。
4. 変更対象は `src/message/parameterScope.ts` / `src/session/bidi.ts` / `src/session/namespaceLoops.ts` / `src/session.ts` / `src/message/parameterScope.test.ts` とする。必要に応じて `src/session/bidi.test.ts` / `src/session/namespaceLoops.test.ts` を追随させる。

## 完了条件

- 現状に列挙した 10 箇所の到達不能フォールバック式がなくなること。
- 検証失敗時の reject と close の順序・同一 `SessionError` オブジェクト性が変わらないこと。
- 旧コールバック API と boolean 戻り値が残っていないこと。
- 既存テストが全て通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加すること。

## 関連

- draft-ietf-moq-transport-21 §9.20.1 / §9.3
- `validateParameterScope` (`src/message/parameterScope.ts`) / `validateRequestOkNoTrackProperties` / `bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse` / `bidiHandleRequestUpdateOk` (`src/session/bidi.ts`)
- `namespaceValidateInitialOk` / `namespaceStartPublicationStreamLoop` (`src/session/namespaceLoops.ts`)
- `issues/0498-refactor-bidi-namespace-dedup.md` / `issues/0577-refactor-namespace-loop-dedup.md` (本 issue で API を確定させた後に実施する)
- `issues/0572-bug-empty-message-track-properties-close.md` (同じ検証関数群を扱う。本 issue の API 確定後に実施する)
