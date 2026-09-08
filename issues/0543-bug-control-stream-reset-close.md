# 制御ストリームの RESET_STREAM でセッションを PROTOCOL_VIOLATION で閉じる

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-control-stream-reset-close
- Polished: 2026-09-08

## 目的

draft-ietf-moq-transport-20 §3.3 は「A control stream MUST NOT be closed at the underlying transport layer during the session's lifetime. Doing so results in the session being closed as a PROTOCOL_VIOLATION.」と定める。現状はピアの RESET_STREAM で制御ストリーム読み取りが reject しても、セッションを閉じずに半壊状態が残る。

## 現状

- `src/session.ts` の `startControlMessageLoop` は、`reader.read()` が `done` を返した場合は `if (this.sessionState === "connected")` でガードして `closeWithError(PROTOCOL_VIOLATION)` する。
- しかし `reader.read()` が reject した場合は catch で `notifyErrorIfActive` を呼ぶだけで、`notifyErrorIfActive` は冒頭の `if (this.sessionState !== "connected") { return; }` を通ったうえで `callbacks.error` を呼ぶのみ（`isSessionClosedError` 以外）。セッションは閉じず `sessionState` が `connected` のまま残る。
- `src/session/errors.ts` の `isPeerStreamError` は `source === "stream"` を真とし、その JSDoc と `src/session/errors.test.ts` のコメントは「ピア起因の stream error はセッション終了 (PROTOCOL_VIOLATION) に昇格させない」としている。制御ストリームの RESET_STREAM は `isPeerStreamError` に該当するため、§3.3 の MUST を満たすにはこの規則の例外が必要になる。
- `startControlMessageLoop` の try は `reader.read()` だけでなく `controlReader.feed` / `handleControlMessage` も含むため、catch は `callbacks.goaway` / `callbacks.debug` などアプリコールバックの throw も捕まえる。これらを一律 PROTOCOL_VIOLATION にすると、アプリ例外がピアのプロトコル違反として扱われる。

## 設計方針

1. catch で `isPeerStreamError(err)` が真（制御ストリームの RESET_STREAM）の場合に限り、`sessionState === "connected"` をガードして `closeWithError(new SessionError(..., PROTOCOL_VIOLATION))` する。それ以外の例外（アプリコールバックの throw 等）は従来どおり `notifyErrorIfActive` に委ね、セッションを閉じない。
2. FIN 経路（`done`）と RESET 経路（`isPeerStreamError`）で `sessionState === "connected"` のガードを共通ヘルパーにまとめ、片方だけの修正漏れと既に閉じたセッションでの誤通知を防ぐ。既に閉じたセッションで read が reject しても何もしない。
3. 制御ストリームの RESET_STREAM は §3.3 により `isPeerStreamError` の「stream error は昇格させない」規則の例外であることを、`isPeerStreamError` の JSDoc と関連テストコメントに明記する。
4. 制御ストリームの RESET_STREAM でセッションが PROTOCOL_VIOLATION で閉じるテスト、既に閉じたセッションでは誤通知しないテスト、アプリコールバックの throw では閉じないテスト、read reject が `source: "session"`（セッション終了起源）の場合は PROTOCOL_VIOLATION に昇格せず `callbacks.error` も呼ばないテストを追加する。

## 完了条件

- 制御ストリームの RESET_STREAM 検出でセッションが PROTOCOL_VIOLATION で閉じること。
- 既に閉じたセッションでは誤って `callbacks.error` を呼ばないこと。
- アプリコールバック（`callbacks.goaway` / `callbacks.debug` 等）の throw ではセッションを閉じないこと。
- 制御ストリームの read reject が `source: "session"`（セッション終了起源）の場合は PROTOCOL_VIOLATION に昇格せず、`callbacks.error` も呼ばないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §3.3 / §3.5
- `startControlMessageLoop` / `notifyErrorIfActive`（`src/session.ts`）
- `isSessionClosedError` / `isPeerStreamError`（`src/session/errors.ts`）
- `src/session.test.ts` / `src/session/errors.test.ts`
