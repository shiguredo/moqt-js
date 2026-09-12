# リクエスト単位 error コールバックの throw をデバッグ記録に残す

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/add-callback-throw-debug-record
- Polished: {YYYY-MM-DD}

## 目的

`namespaceNotifyError` はリクエスト単位の `callbacks.error` の throw を握り潰すが、記録を一切残さない。アプリのコールバックが例外を投げ続けていても開発者が気づけない。`SessionImpl.closeWithError` はセッション単位の error コールバックの throw をデバッグ記録に残しており、同じ「アプリコールバック例外の吸収」で扱いが非対称になっている。リクエスト単位の throw もデバッグ記録に残す。

## 現状

- `namespaceNotifyError` (`src/session/namespaceLoops.ts`) は `callbacks?.error?.(error)` を try/catch で包み、握り潰して記録しない。
- `SessionImpl.closeWithError` (`src/session.ts`) は `catch (callbackError) { emitDataStreamErrorDebug(callbackError, null) }` で記録する。
- `incomingHandleDatagram` (`src/session/incoming.ts`) は `typeName: "DATAGRAM_CALLBACK_ERROR"` で記録する先例を持つ。
- 3 ループは `session.callbacks.debug` を直接参照して送受信のデバッグ記録を行っており、`SessionInternal` に記録用メソッドは無い。

## 設計方針

1. 握り潰した例外を `session.callbacks.debug` へ記録する。typeName は既存の `DATAGRAM_CALLBACK_ERROR` に倣い、リクエスト単位の error コールバック由来であることが判別できる名前を選ぶ。
2. 記録自体の throw (debug コールバックの throw) は握り潰し、後始末を止めない。
3. 記録は通知が throw した場合のみ行い、正常な通知では記録を増やさない。
4. 3 ループで throw する `callbacks.error` を注入し、デバッグ記録が現れることと、後始末 (確立前 Promise の reject・保留中 REQUEST_UPDATE の reject・`session.closeWithError`) が従来どおり実行されることを検証するテストを追加する。

## 完了条件

- リクエスト単位の `callbacks.error` の throw がデバッグ記録に現れること。
- 記録の追加後も、通知の失敗で後始末が止まらないこと。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。

## 参照

- `namespaceNotifyError` (`src/session/namespaceLoops.ts`)
- `SessionImpl.closeWithError` (`src/session.ts`。デバッグ記録の先例)
- `incomingHandleDatagram` (`src/session/incoming.ts`。`DATAGRAM_CALLBACK_ERROR` の先例)
- `src/session/namespaceLoops.test.ts`
