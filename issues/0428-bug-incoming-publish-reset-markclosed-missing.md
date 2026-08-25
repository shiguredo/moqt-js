# 受信 PUBLISH から生成された subscriber が RESET_STREAM 時に state を closed にしない

- Created: 2026-08-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-incoming-publish-reset-markclosed-missing
- Polished: {YYYY-MM-DD}

## 目的

`runPublishStreamSubLoop` (`src/session.ts`) で受信 PUBLISH から生成された `SubscriberImpl` は、ピア (publisher) の RESET_STREAM によるストリームエラー終了で error コールバックが呼ばれるものの、`markClosed` されず state が "active" のまま残る。bidi 系 subscribe ロール (`bidiReadRequestStreamMessages`) は closed issue 0410 で「RESET_STREAM → error 通知 + state closed + セッション非閉鎖」に統一されたため、受信 PUBLISH 経路が非対称になる。同じイベントに対する処理を `notifySubscriberFailure` 経由で統一し、state を closed に遷移させる。

## 現状

- `runPublishStreamSubLoop` の catch (`src/session.ts`) は、`impl.state === "active" && !goawayReceived` かつ `!isSessionClosedError` の場合に `callbacks.error(normalizedError)` を呼ぶが、`markClosed` を呼ばない (GOAWAY 受信後は error 通知も抑止される)。
- FIN (PUBLISH_DONE なし) 経路は `notifySubscriberFailure` (旧 `notifySubscriberFin`) を呼んで error 通知 + markClosed している (`src/session.ts` の runPublishStreamSubLoop 内、`bidi.notifySubscriberFailure`)。RESET 経路だけが error 通知のみで state が "active" のままになる。
- 本問題は closed issue 0374 の「残余リスク (1)」として記録されていたが、0374 は closed 済みで追跡先が消滅している。issue 0410 の実装 (bidi 系 RESET の通知 + markClosed) により非対称性が顕在化した。
- セッション終了 (source: "session") で reject する場合: `isSessionClosedError` ガードで error 通知されないが、markClosed もされない (セッション終了時は subscriber の state が残る。0374 の残余リスクの同族)。
- 影響: アプリは subscription 終了を error コールバックで検知できるものの、`state` が "active" のままのため、state ベースのアプリロジック (送信停止の判断等) が機能しない。

## 設計方針

- RESET_STREAM 相当 (source: "stream" のエラー) での error 通知に加えて `markClosed` する。既存の `notifySubscriberFailure` (`src/session/bidi.ts`) を呼ぶ形に寄せるか、catch 内で `impl.markClosed()` を追加する。
- 0410 と揃えるなら (a) `notifySubscriberFailure` を呼んで error 通知 + markClosed (メッセージは既存の raw error を渡すか、0410 の固定文言 `RESET_REQUEST_STREAM_MESSAGE` に揃えるかは実装時に確定)、(b) 現行の error 通知 + `markClosed()` の 2 行を追加する最小変更。`raw WebTransportError` をそのまま通知する現行動作を維持するか、0410 と文言を統一するかの判断が必要。
- 対象外: セッション終了 (source: "session") での markClosed (セッション終了時は transport.closed ハンドラが sessionState を遷移させる。subscriber 個別の markClosed をすべきかは別議題)。
- 変更対象: `src/session.ts` (runPublishStreamSubLoop の catch)、該当テスト (session.test.ts または実 W3C ストリーム注入方式の追加)、`CHANGES.md`。

## 完了条件

- 受信 PUBLISH 由来の subscriber でピアの RESET_STREAM (source: "stream") を検出した場合、error コールバックが呼ばれ state が closed になること。
- セッションは閉じないこと (ProtocolViolationError ではない)。
- GOAWAY 受信済みでは通知されず state も変更されないこと (現行挙動の維持)。
- セッション終了 (source: "session") では error コールバックが呼ばれないこと (現行挙動の維持)。
- 正常な PUBLISH_DONE → FIN の既存処理が変わらないこと。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection / RESET_STREAM)
- draft-ietf-moq-transport-19 §5.1.1 (Subscription State Management)
- 関連: `issues/closed/0410-bug-subscribe-error-end-not-notified.md` (bidi 系 subscribe の RESET 通知。本 issue は受信 PUBLISH 経路の間口を揃える)
- 関連: `issues/closed/0374-moqt-draft-19-fin-without-publish-done-not-notified.md` (残余リスク (1) の記録箇所)
