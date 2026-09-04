# RESET_STREAM の error code が subscriber のエラー通知に反映されない

- Created: 2026-08-25
- Completed: 2026-09-04
- Branch: feature/fix-reset-stream-error-code-not-notified
- Polished: 2026-08-28

## 目的

subscribe ロールでピアの RESET_STREAM を検出した際、subscriber の error コールバックに渡るエラーが固定文言 (`publisher reset request stream`) のみで、ピアが用いたエラーコード (CANCELLED / TOO_FAR_BEHIND / DELIVERY_TIMEOUT 等、draft-ietf-moq-transport-19 §3.3.4 の SHOULD「The application SHOULD use a relevant error code when resetting or sending STOP_SENDING on any stream.」) がアプリへ伝わらない。アプリが終了理由を区別して挙動を変えられない状態を解消する。RESET 通知経路は closed issue 0410 (bidi 系) と open issue 0428 (受信 PUBLISH 系) の 2 箇所にあり、本 issue はその両方を対象にする。

## 現状

- `bidiReadRequestStreamMessages` (`src/session/bidi.ts`) の外側 catch (closed issue 0410 で追加) は、`isPeerStreamError` (source: "stream") を検出すると固定文言の `new Error(RESET_REQUEST_STREAM_MESSAGE)` を `notifySubscriberFailure` に渡す。`WebTransportError` の `streamErrorCode` は捨てられる。
- open issue 0428 で追加予定の `runPublishStreamSubLoop` (`src/session.ts`) の RESET 経路も、同じく `RESET_REQUEST_STREAM_MESSAGE` を渡す方針で、streamErrorCode は反映されない。0428 は文言の詰めを本 issue に委ねている。
- FIN (PUBLISH_DONE なし) 経路も固定文言 (`FIN_WITHOUT_PUBLISH_DONE_MESSAGE`) だが、FIN は仕様上コードを持たない (RESET_STREAM とは別イベント) ため本 issue の対象外とする。
- ピアが RESET_STREAM にどの error code を使ったかは、WebTransport の `reader.read()` の reject 値である `WebTransportError` の `streamErrorCode` プロパティ (W3C WebTransport 仕様: `unsigned long?`、`source === "stream"` のときのみ非 null) で取得できる。既存コード (`src/session/errors.ts` の `isPeerStreamError`、`src/session/bidi.test.ts` の RESET テスト) も `source` と `streamErrorCode` の 2 属性のみを扱う。
- draft-ietf-moq-transport-19 §3.3.4 (Stream Reset Error Codes) は CANCELLED (0x1) / DELIVERY_TIMEOUT (0x2) / SESSION_CLOSED (0x3) / GOING_AWAY (0x4) / TOO_FAR_BEHIND (0x5) / UNKNOWN_OBJECT_STATUS (0x6) / EXPIRED_AUTH_TOKEN (0x7) / EXCESSIVE_LOAD (0x9) / MALFORMED_TRACK (0x12) / INTERNAL_ERROR (0x0) を列挙する。
- 既存資産として `src/error.ts` の `DataStreamErrorCode` 列挙と `normalizeDataStreamErrorCode` (未知コードを INTERNAL_ERROR に正規化) があり、§3.3.4 の識別に直結する。
- 影響: TOO_FAR_BEHIND でストリームをリセットするピア (再送要求を伴う) と CANCELLED でリセットするピアの区別ができず、アプリは単一の「publisher reset request stream」として処理するしかない。

## 設計方針

- `notifySubscriberFailure` に渡す Error オブジェクトに、`streamErrorCode` を反映した情報を載せる。方式は以下に確定する。
  - reject された `WebTransportError` から `streamErrorCode` (number) を取り出し、`normalizeDataStreamErrorCode` で `DataStreamErrorCode` に正規化する (未知値は INTERNAL_ERROR)。
  - Error オブジェクトの `message` はコード名を付加した可変文言 `` `${RESET_REQUEST_STREAM_MESSAGE}: ${name}(0x${code.toString(16)})` `` に変更する (例: `publisher reset request stream: CANCELLED(0x1)`)。既存 `RESET_REQUEST_STREAM_MESSAGE` 定数はプレフィックス生成用として残す。
  - Error オブジェクトに `streamErrorCode: DataStreamErrorCode` プロパティを転記する (下流の判定分岐が message 文字列比較に依存しないよう、構造化アクセス経路を用意する)。
- `streamErrorCode` が number でない (未提供、または他ブラウザで型が異なる) 場合は現行の固定文言 (`RESET_REQUEST_STREAM_MESSAGE` のみ) で通知し、プロパティ転記も行わない。`CODEBASE.md` の「後方互換性は考慮しない」方針のもとでも、W3C 仕様上「source === "stream" かつ streamErrorCode === undefined」の状況は仕様外挙動として同じフォールバックで扱う。
- 変更対象: `src/session/bidi.ts` (`bidiReadRequestStreamMessages` の catch)、`src/session.ts` (`runPublishStreamSubLoop` の catch。0428 の実装後に本 issue で追記する形になるため、実装順は 0428 → 0429)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。
- 実装順序: 0428 (RESET 経路の markClosed 対称化) を先に実装し、その後に本 issue で両経路の文言拡張を行う。逆順だと 0428 の完了条件「暫定的に 0410 と同一の固定文言」を本 issue が上書きする関係になり、0428 のテスト assert が本 issue の実装で壊れる。
- 低優先。仕様は SHOULD であり、実害はアプリの終了理由識別の制約に留まる。

## 完了条件

- bidi 系と受信 PUBLISH 系の両 catch で、source: "stream" のエラー終了時に `streamErrorCode` (number) を取得できた場合、subscriber の error コールバックに渡る Error の `streamErrorCode` プロパティに正規化済み `DataStreamErrorCode` が入り、`message` にコード名が付加されていること。
- `streamErrorCode` が number でない (`undefined` / 型不一致) 場合は、`message` が現行の `RESET_REQUEST_STREAM_MESSAGE` のみ、Error に `streamErrorCode` プロパティが付かないこと (`{ source: 'stream', streamErrorCode: undefined }` を注入するテストで検証)。
- 未知の `streamErrorCode` (§3.3.4 に列挙されていない値) は `normalizeDataStreamErrorCode` で INTERNAL_ERROR (0x0) に正規化されること。
- FIN 経路 (`FIN_WITHOUT_PUBLISH_DONE_MESSAGE`) の挙動は変更しないこと (回帰ガード)。
- 上記を bidi 系 (`src/session/bidi.test.ts`) の実 W3C ストリーム注入方式で検証するテストがあること。`runPublishStreamSubLoop` 側は 0374 / 0428 と同方針で catch 経路配線をコードレビューで担保する。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection / RESET_STREAM)
- draft-ietf-moq-transport-19 §3.3.4 (Stream Reset Error Codes / 「The application SHOULD use a relevant error code when resetting or sending STOP_SENDING on any stream.」および CANCELLED / TOO_FAR_BEHIND / DELIVERY_TIMEOUT 等の名前付き列挙)
- draft-ietf-moq-transport-19 §15.11.4 (Stream Reset Error Codes の IANA 登録レジストリ)
- W3C WebTransport (https://w3c.github.io/webtransport/) の `WebTransportError` (`source` / `streamErrorCode`)
- 関連: `issues/closed/0410-bug-subscribe-error-end-not-notified.md` (RESET 通知の実装。本 issue は通知内容の拡張)
- 関連: `issues/0428-bug-incoming-publish-reset-markclosed-missing.md` (受信 PUBLISH 経路の RESET 通知 + markClosed。本 issue で同経路の文言拡張も行う)

## 解決方法

`src/session/bidi.ts` に通知用エラー組み立て `createResetStreamError` を新設し、bidi 系 (`bidiReadRequestStreamMessages`) と受信 PUBLISH 系 (`src/session.ts` の `runPublishStreamSubLoop`) の両 catch で共用した。

- 読み取り失敗値の `streamErrorCode` が数値の場合は `normalizeDataStreamErrorCode` で正規化し、通知エラーの `streamErrorCode` プロパティに載せ、メッセージを可変文言に変更する (例: `publisher reset request stream: CANCELLED(0x1)`)
- 数値でない場合 (未提供・型不一致・非オブジェクト) は従来の固定文言のみで通知し、プロパティを付けない
- 未知値は内部エラーに正規化する
- FIN 経路は変更しない
- テストは `src/session/bidi.test.ts` に 5 本、`src/session.test.ts` に受信 PUBLISH 経路の 1 本を追加し、実ストリーム注入で検証する
- `CHANGES.md` の `## develop` に `[FIX]` を追記する
