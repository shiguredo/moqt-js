# 未知 Message Parameter 受信時に PROTOCOL_VIOLATION でセッションを閉じていない

Created: 2026-05-02
Completed: 2026-05-03
Model: Opus 4.7

## 概要

`0040-bug-unknown-parameter-not-closing-session` で `getMessageParameterValueEncoding()` のフォールバック削除が実施されたが、現在の実装は `throw new Error("unknown message parameter type: ...")` 止まりで、上位の制御メッセージループでこの例外を `SessionError(PROTOCOL_VIOLATION)` に翻訳してセッションを閉じる経路が存在しない。

そのため、未知 Message Parameter を含むメッセージを受信すると、デコード例外が catch されて `closeWithError(SessionErrorCode.INTERNAL_ERROR)` 相当の挙動になる、もしくは握り潰される可能性が高い。仕様の MUST「PROTOCOL_VIOLATION でセッション終了」と一致しない。

## RFC 根拠

draft-ietf-moq-transport-17 Section 9.3 Message Parameters (line 2664-2669):

> All Message Parameters MUST be defined in the negotiated version of MOQT or negotiated via Setup Options. An endpoint that receives an unknown Message Parameter MUST close the session with PROTOCOL_VIOLATION. Because the receiver has to understand every Message Parameter, there is no need for a mechanism to skip unknown parameters.

同セクション (line 2674-2678):

> Senders MUST NOT repeat the same Parameter Type in a message unless the parameter definition explicitly allows multiple instances of that type to be sent in a single message. Receivers SHOULD check that there are no unexpected duplicate parameters and close the session with PROTOCOL_VIOLATION if found.

## 該当箇所

- `src/message/parameter.ts:538-544` `getMessageParameterValueEncoding()` — `throw new Error(...)`
- 呼び出し元 `decodeMessageParameter` (`src/message/parameter.ts:600`) も `Error` を素通しする
- `src/session.ts` の制御メッセージループに `error instanceof Error && message === "unknown message parameter type"` を `PROTOCOL_VIOLATION` に昇格する分岐がない (要確認)

## 期待される動作

- `parameter.ts` 側で `ProtocolViolationError` (`src/error.ts:170` 付近) または `SessionError(SessionErrorCode.PROTOCOL_VIOLATION)` を直接 throw する。
- 制御メッセージ受信ループで `ProtocolViolationError` / `SessionError` を catch した場合、対応するエラーコードでセッションを閉じる。
- 同時に「同じ Message Parameter 種別が複数回出現」の SHOULD 検出 (§9.3) も `decodeParameters` (`src/message/parameter.ts:668` 周辺) に追加する。

## 補足

`0040` の解決方法欄では「フォールバックを削除しエラーをスローするようにした」とのみ記載されており、PROTOCOL_VIOLATION への昇格までは扱っていない。本 issue はそのフォローアップ。

## 優先度

重大。Future-extension の grease 値や draft-18 で追加されたパラメータが届いた際、現状はセッションが意図しない種類のエラーで切断される (もしくは握り潰される) ため、相互運用試験で MUST 違反として検出される。

## 解決方法

- `src/message/parameter.ts` の `getMessageParameterValueEncoding()` で `throw new Error(...)` を `throw new ProtocolViolationError(...)` に変更した
- `src/message/parameter.ts` の `decodeParameters()` で重複パラメータの検出を追加した (SHOULD)
- `ProtocolViolationError` は制御メッセージループで catch して `SessionErrorCode.PROTOCOL_VIOLATION` でセッションを閉じる経路が既に存在するため、追加のハンドリングは不要
- テストを `src/message/parameter.test.ts` に 2 件追加した
