# 高レベル API に旧 session のエラーが届き、publisher が別の原因の start 失敗を通知しない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-session-error-generation-guard
- Polished: 2026-11-10

## 目的

高レベル API (`createMediaPublisher` / `createMediaSubscriber`) の `onError` の通知条件に 2 つの問題がある。どちらも `connectToServer` が Session に渡す `onSessionError` の閉包の問題であり、同じ閉包の中で判定の順が互いの正しさを決めるため、1 つの issue で直す。

1. publisher の `sessionErrorNotifiedDuringStart` は、`start()` の実行中に `onSessionError` が 1 度でも呼ばれると立ち、その後の `start()` の失敗は原因が違っても `notifyStartFailure` で抑止される。Session を閉じない通知 (`sessionNotifyErrorIfActive` 経由) でも立つため、別の原因の `start()` の失敗が `onError` に届かない
2. publisher / subscriber の `onSessionError` に世代ガードが無い。close の通知は `handleSessionClose` が世代を比べて旧 session の通知を捨てるが、`onSessionError` は比べないため、解放の開始後 (`stop()` / `close()` / `start()` の失敗の巻き戻し) や、`stop()` の後に再 `start()` した後に、旧 session の `closeWithError` が `onError` に届く

## 現状

- Session の `ConnectCallbacks.error` を呼ぶのは `src/session/lifecycle.ts` の 2 つだけである
  - `sessionCloseWithError(session, error: SessionError)`: 通知のあと必ず Session を閉じる
  - `sessionNotifyErrorIfActive(session, error: Error)`: 受信ループの読み取りエラーを型を問わず通知し、Session を閉じない。`sessionState` が `"connected"` でなければ通知せず、`isSessionClosedError` に当たるものは通知せず状態だけを閉じる
- `src/createMedia/connect.ts` の `connectMediaSession` は、`error` を `onSessionError` へそのまま渡す。世代は持たない
- publisher (`src/createMediaPublisher.ts`)
  - `start()` は冒頭で `sessionErrorNotifiedDuringStart` を false にし、`startInFlight` を true にする。catch は `disposeAllResources()` の後でフラグを読み、`startInFlight` を false にして `notifyStartFailure(error, sessionErrorNotified)` を呼ぶ。巻き戻しの間も `startInFlight` は true のままである
  - `connectToServer` の `onSessionError` は、`startInFlight` なら error の種類を見ずにフラグを立て、`this.callbacks.onError?.(error)` を呼ぶ。世代は比べない
  - `notifyStartFailure` は `isErrorNotifiedByPublisher(error)` か `sessionErrorNotified` なら通知しない
  - フラグが要るのは、同じ原因が Session のエラーと `start()` の失敗の両方に載る経路のためである。PUBLISH_NAMESPACE_OK のスコープ違反 (`src/session/namespaceLoops.ts` の `namespaceRejectAndCloseWithError` が `reject(error)` と `session.closeWithError(error)` を行う) と、`ProtocolViolationError` の `SessionError` への変換 (`toProtocolViolationSessionError`) である。どちらも `sessionCloseWithError` を通るため、届く error は `SessionError` である。フラグのコメントは「変換で別インスタンスになる経路があるため、error の同一性比較ではなくこのフラグで判定する」と書く (closed の 0887 が入れた)
- subscriber (`src/createMediaSubscriber.ts`)
  - `connectToServer` の `onSessionError` は `this.callbacks.onError?.(error)` だけを呼び、世代を比べない。`handleSessionClose` は `generation !== this.sessionGeneration` で旧 session の通知を捨て、`disposeAllResources` は先頭で `sessionGeneration` を進める。問題 2 は publisher と同じく起こる
  - `start()` の catch は常に `onError` を呼び、start 中の抑止を持たない。問題 1 は起こらない
- 問題 1 の再現の例: publisher の `start()` が `publishNamespace` の応答を待つ間に、ピアが開いた双方向ストリームを先頭メッセージより前に RESET_STREAM する。`src/session/incomingPublish.ts` の `incomingPublishReadFirstBidiMessage` の catch から `notifyErrorIfActive` に入り (`source` が `"stream"` の WebTransportError は `isSessionClosedError` に当たらない)、Session を閉じずに `onSessionError` が呼ばれてフラグが立つ。その後に告知が REQUEST_ERROR で失敗すると、`onError` には RESET_STREAM のエラーだけが届き、`start()` の失敗は届かない
- 問題 2 の再現の例: `stop()` で `disposeAllResources` が世代を進めてから `session.close()` で閉じ終えるまでの間に、旧 session の制御ループが `closeWithError` を呼ぶ (`sessionCloseWithError` は Session の状態を見ない)。publisher / subscriber とも `onError` が呼ばれる。publisher では、`stop()` の後の再 `start()` の実行中に届くと、新しい `start()` のフラグまで立てる
- `docs/HIGH_LEVEL_API.md` の MediaPublisher の「状態遷移」は「解放のあとに届く旧 session の close 通知 (新しい session を確立したあとに届く旧 session の通知を含む) では state も `onClose` も変わらない」と書くが、エラーの通知については書いていない。`src/codec/types.ts` の `MediaPublisher.close` の JSDoc も同じ趣旨の文 (括弧書きは無い) を持ち、`MediaSubscriber.close` の JSDoc は「解放のあとに届いた session の close 通知では state も onClose も変わらない」と書く。MediaSubscriber の「状態遷移」には旧 session の通知を扱う文が無い

## 設計方針

- publisher の `onSessionError` は、`error instanceof SessionError` のとき (`sessionCloseWithError` 経由で Session を閉じる原因のとき) だけ `sessionErrorNotifiedDuringStart` を立てる。`SessionError` でない通知 (`sessionNotifyErrorIfActive` 経由) では立てない
  - 根拠: `start()` の失敗に同じ原因が載るのは、Session が閉じて保留中の待ちが reject される場合と、Session の終了による解放で `assertStartNotDisposed` が失敗する場合だけである。`sessionNotifyErrorIfActive` の通知は Session を閉じず、publisher の保留中の要求も reject しない
  - 前提: `sessionNotifyErrorIfActive` が `SessionError` を `ConnectCallbacks.error` へ通知しないこと。次の 3 つで成り立つ。この前提は `ConnectCallbacks.error` の JSDoc に書かれていないため、`onSessionError` の閉包のコメントにこの形で依存関係を書く
    - FIELD_LENGTH_EXCEEDED は `sessionHandleFieldLengthExceeded` が先に `sessionCloseWithError` で閉じる。`incomingPublishReadFirstBidiMessage` はその後も同じ error で `notifyErrorIfActive` を呼ぶが、`sessionClose` が同期的に `sessionState` を `"closed"` にするため、`sessionNotifyErrorIfActive` の状態の判定で捨てられる
    - `SessionError` を投げる decode は `toSessionCloseError` から `closeWithError` に渡る。`toProtocolViolationSessionError` を使う経路 (GOAWAY など) の decode は `SessionError` を投げない
    - `ProtocolViolationError` は `SessionError` を継承しない (`src/error.ts`)
  - 「同じ原因か」を error の同一性や由来の記録で判定する案と、Session エラーの通知後も `start()` の失敗を通知する案は採らない。前者は変換で別インスタンスになるため成り立たず (0887 で退けた)、後者は `docs/HIGH_LEVEL_API.md` の「(Session のエラーと `start()` の失敗に同じ原因が載る経路も重複しない)」と既存テストに反する
- publisher / subscriber の `onSessionError` の閉包の先頭で `startGeneration !== this.sessionGeneration` なら return し、旧 session の通知はフラグも立てず `onError` も呼ばずに捨てる。判定はフラグを立てる前に置く (後に置くと、巻き戻し中に届いた旧 session の通知が元の `start()` の失敗の通知を、再 `start()` の実行中に届いた旧 session の通知が新しい `start()` の失敗の通知を抑止する)。捨てる範囲は `handleSessionClose` と揃え、`disposeAllResources` が世代を進めた時点以降とする
- ソースの変更は 2 クラスの `connectToServer` の閉包と、次のコメントの文言に限る。`src/createMedia/connect.ts` は変えない。docs / 公開型の JSDoc / テストは完了条件で扱う
  - 両クラスの世代の意味を書いたコメント (`sessionGeneration` のフィールドコメント、`connectToServer` の `@param startGeneration`、`disposeAllResources` の世代を進める旨のコメント) で、世代が close 通知だけを捨てると読める記述を、Session のエラーの通知も `onSessionError` の閉包が捨てる記述に直す
  - publisher の抑止のフラグを説明する次の 3 か所
    - `sessionErrorNotifiedDuringStart` のコメントの「start() の実行中に Session の error コールバックが error を通知したか。」を「start() の実行中に Session を閉じる原因を通知したか。」に
    - `notifyStartFailure` の JSDoc の「start() の実行中に Session の error コールバックが error を通知していれば通知しない」を「start() の実行中に Session を閉じる原因を通知していれば通知しない」に
    - 同 `@param sessionErrorNotified` の「start() の実行中に Session の error コールバックが error を通知したか」(JSDoc の改行を挟む) を「start() の実行中に Session を閉じる原因を通知したか」に
- 対象外
  - リクエスト単位の callbacks (publisher の `createPublishers` の `error` と `announceNamespace` の確立後の `error`、subscriber の `subscribeMediaTracks` の `error` と catalog の購読の `reportError`)。世代を見ずに `onError` に流すが、`onSessionError` の問題ではない
  - `connectToServer` の中止経路 (`sessionGeneration !== startGeneration`) で `session.close()` の失敗を `onError` に流す既存の通知。意図した通知であり変えない
  - GOAWAY の閉包 (`onSessionGoaway`) の世代判定。open の 0944 が扱う
  - subscriber の `start()` の実行中に Session を閉じる原因が届くと、Session のエラーと `start()` の失敗で `onError` が 2 回になり得る件。subscriber の `start()` の catch は初期実装から失敗の理由を常に `onError` へ通知する既存の扱いであり (open の 0836 もこれを前提にしている)、変えるかは別の目的になる
- 0944 との関係: 0944 は、同じ `connectToServer` の `onSessionGoaway` の閉包とリクエストストリームの callbacks に `startGeneration` を捕捉させる。本 issue と重なるのは `openSession` に渡す設定の隣り合う閉包であり、世代の判定の書き方を揃え、後から着手する側が先の変更を残す

## 完了条件

- publisher: `start()` の実行中に `SessionError` でない error が `onSessionError` に届き、その後 `start()` が別の原因で失敗したとき、`onError` は両方を 1 回ずつ受け取る
- publisher: `start()` の実行中に `SessionError` が `onSessionError` に届き、`start()` が失敗したとき、`onError` は 1 回だけ受け取る (既存の 2 つのテスト「start: Session error と同じ error の start 失敗は onError を二重に通知しない」/「start: SessionError へ変換された原因でも onError を二重に通知しない」が `notifySessionError` に渡す値を、実際の経路に合わせて `SessionError` に直したうえで通る)
- publisher: 解放の開始後 (`stop()` / `close()` / `start()` の失敗の巻き戻し) に旧 session の閉包の `onSessionError` が呼ばれても、`onError` に届かない。`stop()` の後に再 `start()` したとき、旧 session の閉包からの通知は捨て、新しい session の閉包からの通知は届ける。再 `start()` の実行中に旧 session の閉包から `SessionError` が届いても、新しい `start()` の失敗は通知される
- subscriber: `start()` の実行中 (`holdSubscribe`) に `close()` した後と、`start()` の失敗の巻き戻しの間 (`holdSessionClose`) とその後に、旧 session の閉包の `onSessionError` を呼んでも `onError` に届かない (巻き戻しの経路で `onError` が受け取るのは `start()` の失敗の 1 回だけ)。`start()` の失敗の後に再 `start()` したとき、`opened[0]` の閉包からの通知は捨て、再 `start()` の実行中 (`holdSubscribe`) に呼んだ `opened[1]` の閉包からの通知は届ける (再 `start()` もハーネスでは失敗し、巻き戻しで世代が進むため)。subscriber の `start()` の成功経路は node で駆動できないため (ハーネスの `fetch` は必ず throw する) `stop()` の経路は駆動しないが、世代は `disposeAllResources` の先頭で進むため `stop()` も同じ判定で捨てられる
- 上記を `src/createMediaPublisher.test.ts` の `createStartConnectHarness` (接続ごとの `notifySessionError`) と、`src/createMediaSubscriber.lifecycle.test.ts` の `createStartConnectHarness` (`settings.onSessionError` を呼ぶ `notifySessionError` を足す) で固定する
- 契約の記述を直す
  - 書き足す内容は Session 全体のエラー (`onSessionError`) に限る。リクエスト単位の callbacks は対象外のため、「旧 session のエラー」と限定なしに書かない
  - `docs/HIGH_LEVEL_API.md` の MediaPublisher の「状態遷移」の旧 session の close 通知の文と、`src/codec/types.ts` の `MediaPublisher.close` の JSDoc の同じ趣旨の文に、解放のあとに届く旧 session の Session のエラー (セッション全体のエラー) の通知も `onError` に届かないことを書き足す
  - `docs/HIGH_LEVEL_API.md` の MediaSubscriber の「状態遷移」の「ピア起点の close の通知では、解放してから `"closed"` にして `onClose` を通知する。」の段落と、`src/codec/types.ts` の `MediaSubscriber.close` の JSDoc の close 通知の文に、解放のあとに届く旧 session の close 通知と Session のエラー (セッション全体のエラー) の通知では、state も `onClose` も変わらず、`onError` にも届かないことを書き足す
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/createMediaPublisher.ts` の `start` / `notifyStartFailure` / `connectToServer` / `handleSessionClose` / `disposeAllResources` / `sessionErrorNotifiedDuringStart`
- `src/createMediaSubscriber.ts` の `start` / `connectToServer` / `handleSessionClose` / `disposeAllResources`
- `src/createMedia/connect.ts` の `connectMediaSession`
- `src/session/lifecycle.ts` の `sessionNotifyErrorIfActive` / `sessionCloseWithError`、`src/session/incomingPublish.ts` の `incomingPublishReadFirstBidiMessage`、`src/session/namespaceLoops.ts` の `namespaceRejectAndCloseWithError`、`src/error.ts` の `SessionError` / `ProtocolViolationError`
- `src/createMediaPublisher.test.ts` / `src/createMediaSubscriber.lifecycle.test.ts` の `createStartConnectHarness`
- `docs/HIGH_LEVEL_API.md` の MediaPublisher の「状態遷移」/「namespace の告知 (announceNamespace)」、MediaSubscriber の「状態遷移」、`src/codec/types.ts` の `MediaPublisher.close` / `MediaSubscriber.close`
- open の `issues/0944-fix-goaway-notify-state-guard.md` (同じ `connectToServer` の `onSessionGoaway` の閉包に世代判定を足す)、open の `issues/0836-bug-catalog-drain-error-handling.md`
- `issues/closed/0887-add-media-publisher-namespace-announcement.md` (フラグの由来)、`issues/closed/0681-bug-media-publisher-close-state.md` (close の通知の世代ガードの由来)
