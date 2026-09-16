# セッション終了後に同一チャンクの残りメッセージを処理し続ける経路がある

- Created: 2026-09-16
- Completed: 2026-09-17
- Branch: feature/fix-remaining-messages-after-session-close
- Polished: {YYYY-MM-DD}

## 目的

MOQT の制御メッセージは 1 回の read で複数メッセージがまとめて届き得るため、受信ループは `ControlStreamReader.feed` の戻り値 (メッセージ列) を 1 通ずつ処理する。このとき、あるメッセージの処理でセッションを閉じた後に残りを処理し続けると、後続メッセージが別のセッション終了を検出して `callbacks.error` が二重に通知される。

未登録 Authorization Token Alias の参照を Session Termination に変更した際、`bidiPreflightRequestUpdate` がセッションを閉じる場合は読み取りループを終える (`"return"`) ようにして、この欠陥クラスを 1 経路だけ解消した。同じクラスの経路が 2 つ残っている。

## 現状

### 1. 受信 PUBLISH ループの REQUEST_OK 分岐に `sessionState` ガードが無い

`src/session.ts` の `runPublishStreamSubLoop` は、受信 PUBLISH ストリーム上のメッセージを種類ごとに処理する。`MessageType.PUBLISH_STATE_NOTIFY` と `MessageType.REQUEST_UPDATE` の分岐は処理後に `if (this.sessionState !== "connected") { return; }` で打ち切るが、`MessageType.REQUEST_OK` の分岐は `bidiHandleRequestUpdateOk` を呼んで `continue` するだけである。

`src/session/bidi.ts` の `bidiHandleRequestUpdateOk` は、REQUEST_UPDATE_OK のパラメータスコープ違反と、未知の Mandatory Track Property の 2 箇所で `session.closeWithError` を呼び得る。したがって、同一チャンクの REQUEST_OK がこれらでセッションを閉じた後に、残りのメッセージが処理され続ける。後続メッセージが別のセッション終了に当たると、`SessionImpl.closeWithError` は `sessionState` を見ずに `callbacks.error` を呼ぶため、アプリの error コールバックが 2 回呼ばれる。

### 2. PUBLISH_DONE (UPDATE_FAILED) 送出の直後が `break` / `return` で打ち切られない

`src/session/bidi.ts` の `bidiTerminatePublishSubscriptionWithUpdateFailed` は、`publisher.terminate` と `publishSendPublishDone` を通じて間接的にセッションを閉じ得る。

- `src/session/publish.ts` の `publishSendPublishDone` は、PUBLISH_DONE 送信後にストリームを閉じる処理が失敗した場合、PROTOCOL_VIOLATION でセッションを閉じる
- `bidiTerminatePublishSubscriptionWithUpdateFailed` の末尾は `session.onRequestDrained?.()` を呼び、GOAWAY 受信済みで最後の購読だった場合は `SessionImpl.closeIfGoawayDrained` が NO_ERROR でセッションを閉じる

この関数の呼び出しは、`bidiPreflightRequestUpdate` の GOAWAY 経路 (直後に `return "break"`)、publish ロールの REQUEST_UPDATE の INVALID_FILTER・NOT_SUPPORTED・publisher 不在の 3 経路 (直後に `break`) の 4 箇所にある。`"break"` は `switch` を抜けるだけなので、セッションが閉じていても同一チャンクの残りメッセージを処理し続ける。

### 3. 未登録 Alias の参照では発生しない

未登録 Alias の参照は `bidiTerminatePublishSubscriptionWithUpdateFailed` を呼ばず、`bidiPreflightRequestUpdate` が `"return"` を返すため、この 2 経路の問題は無い。受信 PUBLISH 経路 (`processIncomingPublishAuthorizationTokens` の呼び出し元) も、`false` を返した時点で `return` する。

## 設計方針

セッションを閉じ得る処理の直後で、閉じたかどうかを確認して読み取りループを終える。判定は既存の書き方 (`if (this.sessionState !== "connected") { return; }`) に揃える。

- 受信 PUBLISH ループの REQUEST_OK 分岐に、`MessageType.PUBLISH_STATE_NOTIFY` / `MessageType.REQUEST_UPDATE` の分岐と同じ `sessionState` ガードを追加する
- `bidiTerminatePublishSubscriptionWithUpdateFailed` の呼び出し 4 箇所の直後に、`session.sessionState` を確認して閉じていれば読み取りループを終える判定を追加する。`bidiPreflightRequestUpdate` は `"break"` を返す設計であり、セッションを閉じた場合は `"return"` を返す必要があるため、判定を同関数内に置く
- セッションが閉じていない通常ケースの挙動 (GOING_AWAY / INVALID_FILTER / NOT_SUPPORTED の応答後に読み取りを継続する) は変えない

## 完了条件

- 同一チャンクに REQUEST_OK を 2 通連結し、1 通目がスコープ違反でセッションを閉じる場合に、`closeWithError` が 1 回だけ呼ばれる
- 同一チャンクに、PUBLISH_DONE (UPDATE_FAILED) の送出を伴う REQUEST_UPDATE と後続メッセージを連結し、セッションが閉じた場合に後続メッセージを処理しない
- セッションが閉じない場合 (GOING_AWAY 応答、INVALID_FILTER 応答、NOT_SUPPORTED 応答) は、従来どおり同一チャンクの残りメッセージを処理する
- 上記を検証するテストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE)
- draft-ietf-moq-transport-21 §9.5.1 (Updating Subscriptions)
- draft-ietf-moq-transport-21 §6.6 (Termination)

## 解決方法

### 1. 受信 PUBLISH ループの REQUEST_OK 分岐に sessionState ガードを追加

`src/session.ts` の `runPublishStreamSubLoop` で、`bidiHandleRequestUpdateOk` の直後に `if (this.sessionState !== "connected") { return; }` を追加した。同関数は REQUEST_UPDATE_OK のパラメータスコープ違反、未知の Mandatory Track Property、未応答の REQUEST_UPDATE が無い REQUEST_OK の 3 箇所でセッションを閉じ得る (3 箇所目は別 issue の対応で追加されたもの)。PUBLISH_STATE_NOTIFY / REQUEST_UPDATE 分岐と同じ判定に揃えた。

### 2. REQUEST_UPDATE 拒否に伴う PUBLISH_DONE 送出後の打ち切り

`src/session/bidi.ts` の 4 経路で、`bidiTerminatePublishSubscriptionWithUpdateFailed` の後 (またはそれが呼ばれる `respondToPublishRequestUpdate` の後) に `session.sessionState !== "connected"` を確認し、閉じていれば読み取りループを終えるようにした。

- `bidiPreflightRequestUpdate` の GOAWAY 経路: 閉じた場合は `"break"` ではなく `"return"` を返す (呼び出し側は `"return"` で読み取りループを終える)
- publish ロールの INVALID_FILTER 経路: `return` する
- `respondToPublishRequestUpdate` の publisher 不在 / fill fetch 非対応経路: 呼び出し直後に判定して `return` する

セッションが閉じない通常ケース (INVALID_FILTER / NOT_SUPPORTED / GOING_AWAY 応答の後に読み取りを継続する) の挙動は変えていない。

### 3. テスト用セッションの closeWithError を実装に合わせる

`src/testSupport/bidi.ts` の `createPublishReadTestContext` の `closeWithError` が `sessionState` を遷移させていなかったため、SessionImpl と同じく `"closed"` へ遷移させるようにした。遷移しないと打ち切り判定 (sessionState ガード) を検証できない。

### テスト

- `src/session/bidiReadRequestStreamMessages.test.ts`: PUBLISH_DONE の close 失敗で閉じた後に同一チャンクの 2 通目 (スコープ違反) を処理しないこと、セッションが閉じない INVALID_FILTER 拒否では 2 通目まで処理されることを検証
- `src/session.test.ts`: 受信 PUBLISH ストリーム上で同一チャンクに REQUEST_OK を 2 通連結し、1 通目で閉じた場合に `callbacks.error` が 1 回だけ通知されることを検証

### 検証

- `pnpm exec tsc --noEmit` / `pnpm exec vp check` / `pnpm test --run` (2238 passed)
- `CHANGES.md` の `## develop` に [FIX] エントリを追加
