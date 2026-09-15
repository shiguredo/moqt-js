# REQUEST_ERROR の 0x17 UNKNOWN_AUTH_TOKEN_ALIAS の扱いを確定する

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/change-unknown-auth-token-alias-scope
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §8.9 は、未登録の Alias を参照するメッセージを UNKNOWN_AUTH_TOKEN_ALIAS で拒否する MUST を定める。しかし 0x17 は §16.11.1 (Session Termination Error Codes) にのみ登録され、§16.11.2 (REQUEST_ERROR Codes) には登録されていない。現状は REQUEST_ERROR として 0x17 を送っており、§13 の「未知のエラーコードは INTERNAL_ERROR と等価に扱う MUST」によりピア側で INTERNAL_ERROR に読み替えられる。エラー種別が伝わらないため、認証トークンの問題をアプリが判別できない。

## 現状

- `RequestErrorCode` (`src/error.ts`) に 0x17 を定義し、`bidiSendRequestError` と `incomingSendRequestErrorAndClose` から送信している
- 同じ 0x17 を `SessionErrorCode` にも定義しており、ピアが Session Termination として送ってきた場合は正しく正規化できる
- `normalizeRequestErrorCode` は 0x17 を受理集合に含めるため、REQUEST_ERROR 文脈の未登録コードを独自コードとして温存する
- コードコメントは「§12.3 の登録表には 0x17 が収載されていない」「ピア側で UNKNOWN_AUTH_TOKEN_ALIAS として認識されない可能性がある」と相互運用上の帰結を認識している
- 同一 draft の他実装は 0x17 を Session Termination としてのみ扱い、REQUEST_ERROR 文脈には持たない

draft-ietf-moq-transport-21 §8.9:

> The receiver of a message referencing an Alias that is not currently registered MUST reject the message with UNKNOWN_AUTH_TOKEN_ALIAS.

draft-ietf-moq-transport-21 §13:

> Receipt of an unknown error code in any error context (Session Termination, REQUEST_ERROR, PUBLISH_DONE, or Data Stream Reset) MUST be treated as equivalent to INTERNAL_ERROR for that context.

## 設計方針

- §16.11 のレジストリに合わせて Session Termination 側へ寄せるか、§8.9 の MUST を優先して REQUEST_ERROR 送信を維持するかを決める。どちらを選んでも他方の記述に触れるため、選択理由をコードコメントと CHANGES に残す
- 受信側の正規化はレジストリに合わせる。REQUEST_ERROR 文脈の 0x17 は未登録コードとして INTERNAL_ERROR に正規化する
- 送信側を REQUEST_ERROR のまま維持する場合は、登録済みコードで拒否しつつ理由を Reason Phrase で伝える案と比較して決める

## 完了条件

- 0x17 の扱いが決定され、送信側と受信側の双方が決定に沿う
- 決定理由がコードコメントに残る
- 決定を固定するテストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §8.9 (Authorization Token Compression)
- draft-ietf-moq-transport-21 §12.2 (Session Termination Codes)
- draft-ietf-moq-transport-21 §12.3 (Request Error Codes)
- draft-ietf-moq-transport-21 §13 (Grease)
- draft-ietf-moq-transport-21 §16.11.1 (Session Termination Error Codes)
- draft-ietf-moq-transport-21 §16.11.2 (REQUEST_ERROR Codes)
