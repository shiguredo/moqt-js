# SETUP 受信時にセッションを閉じない経路がある

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-setup-receive-close
- Polished: {YYYY-MM-DD}

## 目的

SETUP 受信時に「セッションを閉じる」MUST が課される経路で、現状は例外を throw するだけでトランスポートを閉じない。`initialize()` の呼び出し元である `connect()` は例外を伝播するだけで close しないため、ピアに終了コードが伝わらずセッションが開いたまま残る。アプリは Session ハンドルを得られないため、閉じる手段もない。

## 現状

- server から AUTHORITY を受信した場合、`SessionError` を throw するだけで `closeWithError()` を呼ばない。§9.1.1 は INVALID_AUTHORITY でのセッションクローズを MUST とする
- server から PATH を受信した場合も同様。§9.1.2 は INVALID_PATH を MUST とする
- `decodeSetupPayload` の失敗 (メッセージ Length と Body 長の不一致を含む) も throw のみ。§9 は PROTOCOL_VIOLATION を MUST とする
- 先頭メッセージが SETUP でない場合も throw のみ
- 同じ `initialize()` 内の AUTHORIZATION TOKEN 処理経路は `closeWithError()` を呼んでおり、非対称になっている
- `connect()` (`src/connect.ts`) は `await session.initialize(...)` の例外をそのまま伝播し、WebTransport を閉じる処理を持たない

draft-ietf-moq-transport-21 §9.1.1:

> When an AUTHORITY option is received from a server, or when an AUTHORITY option is received while WebTransport is used, or when an AUTHORITY option is received by a server but the server does not support the specified authority, the session MUST be closed with INVALID_AUTHORITY.

## 設計方針

- `initialize()` 内でセッションを閉じる経路を統一し、`SessionError` は `closeWithError()` を通してから throw する
- 恒久対策として `initialize()` の本体を try/catch で包み、`SessionError` は必ず `closeWithError` を通す形にする。個別の分岐ごとに close を書き足す方式は再発する
- AUTHORITY / PATH は WebTransport クライアントでも受信側の MUST が課されるため、server 専用規則として除外しない

## 完了条件

- AUTHORITY 受信時に INVALID_AUTHORITY でセッションが閉じられる
- PATH 受信時に INVALID_PATH でセッションが閉じられる
- SETUP のデコード失敗時に PROTOCOL_VIOLATION で閉じられる
- 先頭メッセージが SETUP でない場合も閉じられる
- 既存の AUTHORIZATION TOKEN 経路の挙動が変わらない
- テストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §9 (Control Messages)
- draft-ietf-moq-transport-21 §9.1.1 (AUTHORITY)
- draft-ietf-moq-transport-21 §9.1.2 (PATH)
- draft-ietf-moq-transport-21 §6.6 (Termination)
