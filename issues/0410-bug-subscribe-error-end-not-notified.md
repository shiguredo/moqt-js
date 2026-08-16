# subscribe ロールのエラー終了 (RESET_STREAM) 時に subscriber の終了通知が失われる

- Created: 2026-08-11
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subscribe-error-end-not-notified
- Polished: 2026-08-16
- Updated: 2026-08-15

## 目的

`bidiReadRequestStreamMessages` (`src/session/bidi.ts`) の subscribe ロールで、ピアが RESET_STREAM でストリームをエラー終了させた場合に、subscriber の error コールバックが呼ばれず state が "active" のまま残る問題を修正する。FIN (PUBLISH_DONE なし) 経路の終了通知は closed issue 0374 で実装済みだが、エラー終了経路は対象外として記録されたまま未対応である。なお error 通知は仕様上の MUST / SHOULD ではない (0374 と同様、アプリが subscription の終了を検知できるようにする実用上の対応)。

## 現状

- `bidiReadRequestStreamMessages` の外側 catch は `toProtocolViolationSessionError` (`src/session/errors.ts`) で ProtocolViolationError のみ PROTOCOL_VIOLATION の SessionError に変換してセッションを閉じ、それ以外 (ピアの RESET_STREAM による WebTransportError 等) は黙殺する。
- 黙殺された場合も finally は実行され、`subscribers` / `subscribersByAlias` / `requestStreams` からエントリが削除されるが、subscriber の error コールバックも state 遷移も行われない。アプリは subscription が終了したことを検知できず、state が "active" のまま残る。
- 同種の終了通知欠落は FIN 経路で closed issue 0374 が解決済み (`notifySubscriberFin`: error 通知 + markClosed)。受信 PUBLISH 経路 (`src/session.ts` の `runPublishStreamSubLoop`) は catch で `impl.state === "active" && !goawayReceived && !isSessionClosedError(error)` のとき error コールバックを呼ぶ (GOAWAY 受信後は spurious error 通知を抑止、セッション終了由来も抑止) ため、subscribe ロールの読み取り経路のみが非対称に未対応のままである。なお `runPublishStreamSubLoop` は error 通知のみで markClosed しない点が 0374 の残余リスク (1) として記録されており、本 issue のスコープ外。
- 本 issue の実装によりエラー終了が可視化されるため、0374 が FIN 経路で記録した残余リスク (4) (REQUEST_ERROR 受信後の FIN で error が追加発火) と同構図が RESET 経路にも当てはまる (受信 REQUEST_ERROR は state を閉じないため、その後の RESET で通知が発火し得る)。この残余は本 issue のスコープ外とし、0374 と同様に記録のみ行う。
- 検出契機はピアの RESET_STREAM (ピアの送信方向リセット → 自側 readable がエラー) のみである。ピアの STOP_SENDING は「ピアの受信方向 = 自側の送信方向」のキャンセルであり、自側 readable には影響せず `reader.read()` は reject しない (§3.3.3 の方向関係) ため、本 issue の対象外。

## 設計方針

- **通知の契機**: `bidiReadRequestStreamMessages` の外側 catch で、`toProtocolViolationSessionError` が null を返す (ProtocolViolationError 以外) 場合に subscriber のエラー終了として通知する。通知は subscribe ロール限定とする (publish ロールの catch では通知しない。完了条件の回帰ガードと対応)。このケースの代表例はピアの RESET_STREAM によるストリームエラーであり、プロトコル違反ではないためセッションは閉じない。通知対象の範囲は「ストリームエラー (source: "stream") 限定」にするか「非 ProtocolViolationError 全般」にするかを実装時に確定する (前者は `isPeerStreamError` で絞る。後者の場合、subscribe ロールのデコード失敗 (IncompleteDataError 等) や内部エラーでも通知され、エラー文言が原因誤認になるため、文言は `publisher reset request stream` 固定ではなく汎用化する)。なお 0409 が方式 (b) を選んだ場合、IncompleteDataError は変換されて通知対象から外れるため、挙動が 0409 の実装内容に依存して変わる。
- **セッション終了の除外**: ピア起因のセッション終了 (source: "session" のエラー) では通知しない (`isSessionClosedError` で判定)。`transport.closed` ハンドラは sessionState のみ遷移させ subscriber の markClosed を実行しないため、ガード (state が "active" でない場合は通知しない) では抑止できない。通知すると `ConnectCallbacks.close` によるセッション終了通知と二重になる。既存の `runPublishStreamSubLoop` の catch と同じ `isSessionClosedError` の扱いを採用する。
- **通知方法**: closed issue 0374 の `notifySubscriberFin` を流用するか、同様のガード付きのエラー通知専用処理にするかを実装時に確定する。`notifySubscriberFin` は「FIN 専用」「subscribe ロール専用」と JSDoc に明記されているため、流用する場合は JSDoc の更新が必要。エラー文言は FIN 経路 (`publisher closed request stream without PUBLISH_DONE`) と区別できるものにする (例: `publisher reset request stream`)。
- **ガード**: `notifySubscriberFin` と同様、subscribers に存在しない場合・state が "active" でない場合は通知しない。GOAWAY 受信済みの場合は通知しない (GOAWAY 後の RESET_STREAM は旧ストリームの破壊 = migration の完了であり、§10.4「The GOAWAY message does not impact subscription state」の趣旨と 0374 の確定内容 (GOAWAY 後の FIN は通知しない) に整合)。notifySubscriberFin を流用すると GOAWAY ガードも自動的に適用される。
- **テスト**: 0374 方式の実 W3C ストリーム注入 (モック不使用) で、RESET_STREAM 相当のエラー終了 (reader.read() が WebTransportError 相当 (`Object.assign(new Error(...), { source: "stream" })`) で reject する。Node テスト環境には WebTransportError グローバルが存在しないため) を再現して error コールバック + state closed を検証する。セッション終了 (source: "session") のテストは、Node テスト環境では `isSessionClosedError` がメッセージフォールバック ("session is closed" / "session closed") に依存するため、reject する Error のメッセージに "session closed" を含めるか、`errors.test.ts` の FakeWebTransportError 方式のグローバル注入が必要。
- 変更対象ファイル: `src/session/bidi.ts` (`bidiReadRequestStreamMessages` の外側 catch / `notifySubscriberFin` または新規ヘルパー)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- subscribe ロールでピアの RESET_STREAM によるエラー終了を検出した場合、subscriber の error コールバックが呼ばれ state が closed になること。
- セッションは閉じないこと (ProtocolViolationError ではないため)。
- ピア起因のセッション終了 (source: "session") では error コールバックが呼ばれないこと (二重通知の防止)。
- GOAWAY 受信済みのエラー終了では error コールバックが呼ばれないこと。
- publish ロールではエラー終了通知が呼ばれないこと (対象ロール限定の回帰ガード)。
- 正常な PUBLISH_DONE → FIN 経路は従来どおり end コールバックのみ呼ばれること (closed issue 0374 のテストと整合)。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.2 (Graceful Request Stream Closure / FIN は失敗扱い)
- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection / RESET_STREAM と STOP_SENDING の方向関係)
- draft-ietf-moq-transport-19 §5.1.1 (Subscription State Management / 状態破棄の契機)
- draft-ietf-moq-transport-19 §10.4 (GOAWAY / subscription state への影響なし)
- 関連: `issues/closed/0374-moqt-draft-19-fin-without-publish-done-not-notified.md`（FIN 経路の終了通知。エラー終了経路は本 issue の対象として記録された）
- 関連: `issues/0405-bug-subscribe-fin-response.md`（subscribe ロールの FIN 応答。本 issue と同じ `bidiReadRequestStreamMessages` を対象とするため、実装順序・干渉に注意）
- 関連: `issues/0409-bug-publish-stream-request-update-decode-failure.md`（publish ロールの REQUEST_UPDATE デコード失敗。方式 (b) を選んだ場合、外側 catch を同一箇所で変更するため整合に注意）

## 解決方法

未着手。
