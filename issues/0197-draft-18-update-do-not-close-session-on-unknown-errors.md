# 未知エラーコード受信時にセッションを閉じない

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で未知のエラーコードを受信した際にセッションを閉じてはならないと明示された。
未知エラーコードは INTERNAL_ERROR と同等に扱い、セッションは維持する。

## RFC 参照

draft-ietf-moq-transport-18 §14 (Grease):

> Receipt of an unknown error code in any error context (Session
> Termination, REQUEST_ERROR, PUBLISH_DONE, or Data Stream Reset) MUST
> be treated as equivalent to INTERNAL_ERROR for that context. An
> endpoint MUST NOT close the session because it received an unknown
> error code in a REQUEST_ERROR or PUBLISH_DONE.

draft-ietf-moq-transport-18 A.1: "Don't close the Session for unknown errors (#1561)"

## 変更内容

1. `src/error.ts` の `RequestErrorCode` に未知エラーコードを `INTERNAL_ERROR` にフォールバックするヘルパー関数を追加する
2. `src/session.ts` の REQUEST_ERROR 受信箇所で、未知エラーコードの場合にセッションを切断せず `INTERNAL_ERROR` として扱う
3. `src/session.ts` の PUBLISH_DONE 受信箇所で、未知ステータスコードの場合にセッションを切断せずエラー通知のみ行う

## 該当ファイル

| ファイル         | 行番号    | 変更内容                                                                               |
| ---------------- | --------- | -------------------------------------------------------------------------------------- |
| `src/error.ts`   | 50-67     | `normalizeRequestErrorCode()` ヘルパー関数を追加する (未知コード→ `INTERNAL_ERROR`)    |
| `src/error.ts`   | 78-89     | `normalizePublishDoneCode()` ヘルパー関数を追加する (未知コード→ `INTERNAL_ERROR`)     |
| `src/session.ts` | 1616-1626 | `decodeRequestErrorPayload` の errorCode を `normalizeRequestErrorCode()` で正規化する |
| `src/session.ts` | 212-227   | PUBLISH_DONE 処理で未知コードを INTERNAL_ERROR 扱いにする                              |

## 期待される動作

1. 未知の REQUEST_ERROR コード (0x12 以外で既知リストにない値) を受信した場合、セッションは維持される
2. 未知の PUBLISH_DONE コードを受信した場合、セッションは維持され、エラーコールバックが INTERNAL_ERROR として呼ばれる
3. 未知の Session Termination エラーコードを受信した場合も、INTERNAL_ERROR として扱い、即座にセッションを切断しない
4. 既知のエラーコードの処理は従来通り

## テスト方針

- `src/error.test.ts` に `normalizeRequestErrorCode` / `normalizePublishDoneCode` の単体テストを追加する
  - 既知コードはそのまま返ることを検証する
  - 未知コードは `INTERNAL_ERROR` に正規化されることを検証する
- `src/session.ts` の REQUEST_ERROR / PUBLISH_DONE 受信テストで未知コード時のセッション維持を検証する

## 影響範囲

- 実装変更あり
- 後方互換あり (未知エラーコードは従来 PROTOCOL_VIOLATION で切断していたが、切断しなくなる)
- セッション切断の契機が減るため、より堅牢な動作になる
