# RESET_STREAM の error code が subscriber のエラー通知に反映されない

- Created: 2026-08-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-reset-stream-error-code-not-notified
- Polished: {YYYY-MM-DD}

## 目的

subscribe ロールでピアの RESET_STREAM を検出した際、subscriber の error コールバックに渡るエラーが固定文言 (`publisher reset request stream`) のみで、ピアが用いたエラーコード (CANCELLED / TOO_FAR_BEHIND / DELIVERY_TIMEOUT 等、draft-ietf-moq-transport-19 §3.3.4 の「The application SHOULD use a relevant error code when resetting or sending STOP_SENDING」) がアプリへ伝わらない。アプリが終了理由を区別して挙動を変えられない。

## 現状

- `bidiReadRequestStreamMessages` (`src/session/bidi.ts`) の外側 catch (closed issue 0410 で追加) は、`isPeerStreamError` (source: "stream") を検出すると固定文言の `new Error(RESET_REQUEST_STREAM_MESSAGE)` を `notifySubscriberFailure` に渡す。`WebTransportError` が持つ errorCode プロパティ (READ_ERROR の streamErrorCode、または errorCode) は捨てられる。
- FIN (PUBLISH_DONE なし) 経路も固定文言 (`FIN_WITHOUT_PUBLISH_DONE_MESSAGE`) であり、両経路ともアプリが通知内容から終了理由を区別できない。
- ピアが RESET_STREAM にどの error code を使ったかは、WebTransport の `read()` の reject 値 (WebTransportError) の `errorCode`・`streamErrorCode` プロパティで取得できる可能性がある (ブラウザ実装依存)。
- 影響: TOO_FAR_BEHIND でストリームをリセットするピア (再送要求を伴う) と CANCELLED でリセットするピアの区別ができず、アプリは単一の「publisher reset request stream」として処理するしかない。

## 設計方針

- `notifySubscriberFailure` の引数エラーに、WebTransportError の errorCode (StreamErrorCode) を反映する形を検討する (エラーオブジェクトにプロパティを転記する、あるいはメッセージ文言にコード番号/名前を付加する)。判定は実装時に確定する。定数 `RESET_REQUEST_STREAM_MESSAGE` の文言を維持するか、コード付きの可変文言にするかも実装時に確定する。
- errorCode の取得可否はブラウザ実装依存であるため、取得できなかった場合は現行の固定文言にフォールバックする。
- 対象: `src/session/bidi.ts` (`bidiReadRequestStreamMessages` の catch)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。
- 低優先。仕様は SHOULD であり、実害はアプリの終了理由識別の制約に留まる。

## 完了条件

- source: "stream" のエラー終了で errorCode (WebTransportError.errorCode / streamErrorCode) を取得できた場合、subscriber の error コールバックに渡るエラーから終了理由が区別できること。
- errorCode を取得できない場合、現行の固定文言で通知されること (後方互換)。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection / RESET_STREAM)
- draft-ietf-moq-transport-19 §3.3.4 (Stream Error Codes / 「The application SHOULD use a relevant error code when resetting or sending STOP_SENDING」)
- draft-ietf-moq-transport-19 §2.6 (Error Codes の列挙と推奨使用)
- W3C WebTransport の WebTransportError (errorCode / streamErrorCode)
- 関連: `issues/closed/0410-bug-subscribe-error-end-not-notified.md` (RESET 通知の実装。本 issue は通知内容の拡張)
