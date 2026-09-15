# SETUP 受信時にセッションを閉じない経路がある

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-setup-receive-close
- Polished: 2026-09-15

## 目的

SETUP 受信時に「セッションを閉じる」MUST が課される経路で、現状は例外を throw するだけでトランスポートを閉じない。`initialize()` の呼び出し元である `connect()` は例外を伝播するだけで close しないため、ピアに終了コードが伝わらずセッションが開いたまま残る。アプリは Session ハンドルを得られないため、閉じる手段もない。

`issues/closed/0120-bug-setup-authority-path-not-restricted.md` の「解決方法」は、AUTHORITY / PATH の検出時に「上位の `initialize` の呼び出し元が catch して `closeWithError` で閉じる経路を持つ」という前提で完了していた。`connect()` にその経路は無く、前提が成立していなかった。本 issue はこの穴を、個別分岐への close 追加ではなく `initialize()` 内の終了経路の統一として塞ぐ。

## 現状

- server から AUTHORITY を受信した場合、`SessionError` を throw するだけで `closeWithError()` を呼ばない。§9.1.1 は INVALID_AUTHORITY でのセッションクローズを MUST とする
- server から PATH を受信した場合も同様。§9.1.2 は INVALID_PATH でのセッションクローズを MUST とする
- `decodeSetupPayload` の失敗も throw のみ。§9 はメッセージ Length と Body 長の不一致に対して PROTOCOL_VIOLATION でのセッションクローズを MUST とする。現状は KVP の宣言 Length が残りデータを超える場合 (`src/message/parameter/kvp.ts` の `decodeKeyValuePair` が `assertLengthWithinData` 経由で `ProtocolViolationError`)、Delta Type の累積が `MAX_VARINT` を超える場合 (同 `ProtocolViolationError`)、varint が途中で切れている場合 (`src/varint.ts` の `decodeVarint` が `IncompleteDataError`) に失敗する。`ControlStreamReader` は宣言 Length のバイト列を切り出してから `decodeSetupPayload` に渡すため、この不一致は切り出したバイト列の中で KVP 構造が壊れた形で現れる
- 先頭メッセージが SETUP でない場合も throw のみ。`initialize()` は `SessionError(..., SessionErrorCode.PROTOCOL_VIOLATION)` を throw する
- 同じ `initialize()` 内の AUTHORIZATION TOKEN 処理経路は `closeWithError()` を呼んでおり、非対称になっている。`processSetupAuthorizationTokens` (`src/session/authTokenCache.ts`) が throw するのは常に `SessionError` であり、`initialize()` はそれを catch して `closeWithError()` を呼んでから再 throw する
- `connect()` (`src/connect.ts`) は `await session.initialize(...)` の例外をそのまま伝播し、WebTransport を閉じる処理を持たない
- `closeWithError()` (`src/session.ts`) は `callbacks.error` を通知したうえで `void this.close(error.code, error.message)` を呼ぶ。`close()` は最後に `this.transport.close({ closeCode, reason })` を呼ぶため、ここを通ればピアへ終了コードが伝わる

draft-ietf-moq-transport-21 §9.1.1:

> When an AUTHORITY option is received from a server, or when an AUTHORITY option is received while WebTransport is used, or when an AUTHORITY option is received by a server but the server does not support the specified authority, the session MUST be closed with INVALID_AUTHORITY.

draft-ietf-moq-transport-21 §9.1.2:

> When a PATH setup option is received from a server, or when a PATH parameter is received while WebTransport is used, or when a PATH parameter is received by a server but the server does not support the specified path, the session MUST be closed with INVALID_PATH.

## 設計方針

- `initialize()` 内でセッションを閉じる経路を統一し、throw する `SessionError` は `closeWithError()` を通してから throw する
- 恒久対策として、プロトコル違反を検出する受信・デコード処理を try/catch で包み、`SessionError` は必ず `closeWithError` を通す形にする。個別の分岐ごとに close を書き足す方式は再発する
- AUTHORITY / PATH は WebTransport 使用中の受信にも MUST が課されるため、server 専用規則として除外しない

### 確定事項

- 包む範囲は「制御受信ストリームを確定した後に行う、先頭メッセージ種別の検証、SETUP のデコードと検証、AUTHORIZATION TOKEN の処理」に限定する。`initialize()` の本体全体を包んではならない。WebTransport 接続の確立 (`createUnidirectionalStream` / `incomingUnidirectionalStreams` の read)、制御受信ストリームが確定する前の終了 (`Connection closed before receiving control stream` / `Connection closed before SETUP` の `NO_ERROR`)、`transport.closed` による終了はプロトコル違反ではない。これらを閉じる対象に含めると、ピアが SETUP を送らずに閉じた場合に違反として `callbacks.error` を通知し、終了コードにプロトコル違反の値を使う挙動変化になる。既存挙動を変えない
- catch した例外は `src/session/errors.ts` の `toSessionCloseError(error)` で `SessionError` へ正規化し、戻り値が `null` でない場合だけ `closeWithError` に渡す。`SessionError` はコードを保ったまま、`ProtocolViolationError` / `IncompleteDataError` は `PROTOCOL_VIOLATION` の `SessionError` へ変換する。この変換規則は既存の受信ループと同じ関数を使い、経路ごとに書き分けない。これにより `decodeSetupPayload` の失敗も PROTOCOL_VIOLATION で閉じられる。正規化できない例外 (`toSessionCloseError` が `null` を返すもの) は閉じずにそのまま伝播させる
- `closeWithError` に渡すのは正規化後の `SessionError` とし、その後に元の例外を必ず再 throw する。`initialize()` は失敗を reject で伝える契約であり、`connect()` は例外を捕捉しないため、握ると初期化に失敗したセッションを成功として返してしまう。既存の AUTHORIZATION TOKEN 経路と同じ形 (`closeWithError(error); throw error;`) に揃える
- `processSetupAuthorizationTokens` を囲む既存の try/catch は削除し、同じ変換規則に統合する。`SessionError` はコードを保ったまま 1 回だけ `closeWithError` に渡り、`callbacks.error` の通知は 1 回のまま、`close()` も 1 回だけ実行される (二重 close は `close()` 冒頭の `sessionState === "closed"` ガードでは止まらず、`callbacks.error` が 2 回呼ばれる形で現れる)
- AUTHORITY / PATH の受信時は `INVALID_AUTHORITY` / `INVALID_PATH` で閉じる。§9.1.1 / §9.1.2 の MUST は 3 つの条件の論理和であり、moqt-js が該当するのは「WebTransport を使用中に AUTHORITY / PATH を受信した場合」(2 番目) である。1 番目の「server から受信した場合」とは条件が異なるが、閉じる動作とコードは同じ

## 完了条件

- AUTHORITY 受信時に INVALID_AUTHORITY でセッションが閉じられる。`callbacks.error` に渡る `SessionError` の `code` が `SessionErrorCode.INVALID_AUTHORITY` であり、`transport.close()` が `closeCode` に同じコードを渡して 1 回だけ呼ばれる
- PATH 受信時に INVALID_PATH でセッションが閉じられる。検証内容は AUTHORITY と同じ
- SETUP のデコード失敗時に PROTOCOL_VIOLATION で閉じられる。KVP の宣言 Length が残りデータを超えるバイト列を届け、`SessionErrorCode.PROTOCOL_VIOLATION` で閉じられることを検証する
- 先頭メッセージが SETUP でない場合も閉じられる。閉じるコードは現行どおり `SessionErrorCode.PROTOCOL_VIOLATION` とする
- 既存の AUTHORIZATION TOKEN 経路の挙動が変わらない。`initialize()` が reject する例外の型と `code`、`callbacks.error` の通知が 1 回であること、`transport.close()` が 1 回だけ呼ばれることが現行と同じである
- テストがある。`src/session.test.ts` の `createIncomingSetupSession` の transport に `close` を追加して呼び出しを記録し、AUTHORITY / PATH / デコード失敗 / 先頭非 SETUP の 4 経路で `transport.close()` の呼び出し回数と `closeCode`、`callbacks.error` の通知回数を検証する
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §9 (Control Messages)
- draft-ietf-moq-transport-21 §9.1.1 (AUTHORITY)
- draft-ietf-moq-transport-21 §9.1.2 (PATH)
- draft-ietf-moq-transport-21 §6.6 (Termination)
- `issues/closed/0120-bug-setup-authority-path-not-restricted.md` (AUTHORITY / PATH の受信検証を追加した先行 issue。呼び出し元が閉じる前提が誤っていた)
