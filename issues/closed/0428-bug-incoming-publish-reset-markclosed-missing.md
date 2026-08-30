# 受信 PUBLISH から生成された subscriber が RESET_STREAM 時に state を closed にしない

- Created: 2026-08-25
- Completed: 2026-08-31
- Branch: feature/fix-incoming-publish-reset-markclosed-missing
- Polished: 2026-08-28

## 目的

`runPublishStreamSubLoop` (`src/session.ts`) で受信 PUBLISH から生成された `SubscriberImpl` は、ピア (publisher) の RESET_STREAM によるストリームエラー終了で error コールバックが呼ばれるものの、`markClosed` されず state が "active" のまま残る。bidi 系 subscribe ロール (`bidiReadRequestStreamMessages`) は closed issue 0410 で「RESET_STREAM → error 通知 + state closed + セッション非閉鎖」に統一されたため、受信 PUBLISH 経路が非対称になる。同じイベントに対する処理を `notifySubscriberFailure` 経由で統一し、state を closed に遷移させる。実質的な追加変更は catch 経路での `notifySubscriberFailure` 呼び出し (error 通知 + markClosed) 1 点である。

## 現状

- `runPublishStreamSubLoop` の catch (`src/session.ts`) は、`impl.state === "active" && !goawayReceived` かつ `!isSessionClosedError` の場合に `callbacks.error(normalizedError)` を呼ぶが、`markClosed` を呼ばない (GOAWAY 受信後は error 通知も抑止される)。source: "stream" (ピアの RESET_STREAM 起因) と、source: 無し (ProtocolViolationError 経由等の内部例外) を分けていない。
- FIN (PUBLISH_DONE なし) 経路は `notifySubscriberFailure` (旧 `notifySubscriberFin`) を呼んで error 通知 + markClosed している (`src/session.ts` の runPublishStreamSubLoop 内、`bidi.notifySubscriberFailure`)。RESET 経路だけが error 通知のみで state が "active" のままになる。
- bidi 系 subscribe ロールの 0410 実装は `role === "subscribe" && isPeerStreamError(err)` で source を絞ってから `notifySubscriberFailure` を `RESET_REQUEST_STREAM_MESSAGE` 固定文言で呼び出す (`src/session/bidi.ts`)。runPublishStreamSubLoop 側は source 絞り込みが無いため、対称化の基準がずれている。
- 本問題は closed issue 0374 の「残余リスク (1)」として記録されていたが、0374 は closed 済みで追跡先が消滅している。issue 0410 の実装 (bidi 系 RESET の通知 + markClosed) により非対称性が顕在化した。
- セッション終了 (source: "session") で reject する場合: `isSessionClosedError` ガードで error 通知されないが、markClosed もされない。`transport.closed` ハンドラ (`src/session.ts`) は `sessionState` を "closed" に遷移し `callbacks.close` を呼ぶだけで、subscriber ごとの `markClosed` はしないため、subscriber の state は "active" のまま残る (0374 の残余リスクの同族)。
- 影響: アプリは subscription 終了を error コールバックで検知できるものの、`state` が "active" のままのため、state ベースのアプリロジック (送信停止の判断等) が機能しない。
- 関連 open issue 0429 (RESET_STREAM error code 通知) は本 issue と同じ catch を触り、`notifySubscriberFailure` へ渡す Error に WebTransportError の errorCode を反映するのがスコープ。文言の詰めは 0429 で行うため、本 issue では暫定的に 0410 と同一の固定文言を採用する。

## 設計方針

- RESET_STREAM 相当 (source: "stream" のエラー) に対象を絞り、error 通知 + markClosed を行う。判定は 0410 と同一に `isPeerStreamError(err)` で行い、それ以外 (ProtocolViolationError 経由・source: "session"・source 無し) では現行挙動を維持する。
- 実装は 0410 の subscribe ロール側 catch と同型の (a) 案に一本化する: catch 内で `!goawayReceived && isPeerStreamError(err) && !isSessionClosedError(err)` を満たす場合に `bidi.notifySubscriberFailure(this, publishRequestId, new Error(bidi.RESET_REQUEST_STREAM_MESSAGE))` を呼ぶ。error 通知 + markClosed は `notifySubscriberFailure` の内部契約 (try/finally) に委ねる。RESET 分岐では生の `callbacks.error` を呼ばない (notifySubscriberFailure 側が同等の通知を担うため二重通知を避ける)。一方 source: "stream" 以外の raw error 通知パス (else 分岐) は維持する (完了条件の「source: "stream" 以外では現行挙動を維持」に必要)。
- 通知メッセージは暫定的に `RESET_REQUEST_STREAM_MESSAGE` (0410 と同一固定文言) を使う。WebTransportError の errorCode を反映するかは 0429 のスコープで、そこで bidi 系と併せて文言を再検討する。
- `toProtocolViolationSessionError(err)` が非 null の場合の `closeWithError` 呼び出しは現行どおり維持する (RESET 相当と PROTOCOL_VIOLATION は分岐が競合しない)。
- 変更対象: `src/session.ts` (runPublishStreamSubLoop の catch)、`src/session.test.ts` (受信 PUBLISH ストリーム経路のテスト。private メソッドの catch 経路は `handleIncomingBidirectionalStream` を `as unknown as` でキャストし、実 W3C ストリームを注入して駆動できるため、自動テストで担保する)、`CHANGES.md`。

## 対象外 / 別 issue へ切り出し

- セッション終了 (source: "session") 時に subscriber 個別の markClosed が行われず state が "active" のまま残る問題は本 issue のスコープ外とする。0374 の残余リスク (1) と同族の問題であり、本 issue 完了時に `issues/0444-bug-peer-session-close-markclosed-missing.md` として起票し、追跡先を残した (0374 → 0428 で経緯が繰り返さないようにする)。
- WebTransportError の errorCode を通知メッセージへ反映する対応は 0429 のスコープ。

## 完了条件

- 受信 PUBLISH 由来の subscriber でピアの RESET_STREAM (source: "stream") を検出した場合、error コールバックが呼ばれ state が closed になること。
- source: "stream" 以外 (ProtocolViolationError 経由の catch 通過・source: "session"・source 無し) では markClosed が発火せず、現行挙動が維持されること (回帰ガード)。
- セッションは閉じないこと (`toProtocolViolationSessionError` 経路との競合が起きないこと)。
- GOAWAY 受信済みでは通知されず state も変更されないこと (現行挙動の維持)。
- セッション終了 (source: "session") では error コールバックが呼ばれないこと (現行挙動の維持)。
- 正常な PUBLISH_DONE → FIN の既存処理が変わらないこと。
- 上記を検証するテストが `src/session.test.ts` にあること。`runPublishStreamSubLoop` の catch 経路は private メソッドだが、`handleIncomingBidirectionalStream` を `as unknown as` でキャストし実 W3C ストリームを注入して駆動できるため、自動テストで担保する (bidi.test.ts の free function 単体テストではなく経路配線ごと検証する)。
- 別 issue (source: "session" 時の markClosed 欠落) の起票が完了していること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection / RESET_STREAM): cancellation の手段を定めるのみで、受けた側の通知内容・subscription state の扱いは未規定
- draft-ietf-moq-transport-19 §5.1 (Subscriptions): Either endpoint can terminate an Established subscription, moving it to the Terminated state
- 関連: `issues/closed/0410-bug-subscribe-error-end-not-notified.md` (subscribe ロールの RESET 通知。本 issue は受信 PUBLISH 経路の間口を揃える)
- 関連: `issues/closed/0374-moqt-draft-19-fin-without-publish-done-not-notified.md` (残余リスク (1) の記録箇所)
- 関連: `issues/0429-bug-reset-stream-error-code-not-notified.md` (RESET_STREAM の errorCode 通知。本 issue の通知メッセージは暫定的に 0410 と揃え、errorCode 反映は 0429 で subscribe ロール側と一括対応)

## 解決方法

`src/session.ts` の `runPublishStreamSubLoop` の catch を、subscribe ロール側 (`bidiReadRequestStreamMessages`) と同型に揃えた。

- source: "stream" のエラー (`isPeerStreamError(err)` が true、`!goawayReceived && !isSessionClosedError` かつ `impl.state === "active"`) では `bidi.notifySubscriberFailure(this, publishRequestId, new Error(bidi.RESET_REQUEST_STREAM_MESSAGE))` を呼び、error 通知と markClosed を `notifySubscriberFailure` の try/finally 内部契約に委ねる。この分岐では生の `callbacks.error` を呼ばない (二重通知回避)
- source: "stream" 以外 (source を持たない内部例外・ProtocolViolationError 経由) は従来どおり raw の `callbacks.error` を通知し、state は変更しない。ただしアプリの error コールバック例外は内側 try/catch で吸収する (吸収しないと catch ブロック内 throw が Promise を reject させ、呼び出し元 `handleIncomingBidirectionalStream` の requestStreams / subscribers / subscribersByAlias の後始末がスキップされ unhandled rejection になる。FIN 経路は外側 try 内で呼ばれるため元々吸収されており、RESET 経路も同じ意味論に揃えた)
- source: "session" と GOAWAY 受信済みの抑止、`toProtocolViolationSessionError(err)` による `closeWithError` は従来どおり維持
- 語彙は既存コード (subscribe ロール / 受信 PUBLISH) に寄せ、新規テスト 6 本を `src/session.test.ts` に追加 (`handleIncomingBidirectionalStream` を `as unknown as` でキャストし、実 W3C ReadableStream を highWaterMark 0 + pull 方式で決定論的に注入)。修正前コードで落ちるのは RESET 通知系 2 本と source なし throw 吸収 1 本、他は回帰ガード

本 issue のスコープ外として、`transport.closed` 由来のセッション終了時に request 系オブジェクトの markClosed が走らない問題は `issues/0444-bug-peer-session-close-markclosed-missing.md` に切り出した。
