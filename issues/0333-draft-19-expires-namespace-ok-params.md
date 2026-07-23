# SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK で EXPIRES を許可する (draft-19 追従)

- Priority: High
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-expires-namespace-ok
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 10.2.15 (EXPIRES Parameter) で、EXPIRES を付けられるメッセージが拡張されている。

draft-19 Section 10.2.15:

> The EXPIRES parameter (Parameter Type 0x8) is a varint. It MAY
> appear in SUBSCRIBE_OK, PUBLISH, PUBLISH_OK, SUBSCRIBE_NAMESPACE_OK,
> SUBSCRIBE_TRACKS_OK, PUBLISH_NAMESPACE_OK, or REQUEST_UPDATE_OK.

Parameter Type は `0x8`。上記のうち SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK の 3 メッセージが、draft-18 時点の許可集合に対する追加分である。

## 優先度根拠

moqt-js はこの 3 メッセージの許可パラメータを空集合としている。draft-19 準拠サーバーが仕様どおり EXPIRES を付けて応答すると、受信時のスコープ検証が PROTOCOL_VIOLATION を起こしセッション全体を誤って切断する。クライアントが受信する応答メッセージなので実害が出やすく High。

## 現状

- `src/message/parameterScope.ts:61-62`: `EMPTY_ALLOWED_PARAMS` が SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK 用に使われている
- `src/message/parameterScope.ts:107-125`: `validateParameterScope` が許可外パラメータを ProtocolViolationError にする
- `src/message/parameterScope.ts`: SUBSCRIBE_OK / PUBLISH_OK / REQUEST_UPDATE_OK の許可集合には既に EXPIRES がある
- `src/message/types.ts`: `MessageParameterType.EXPIRES: 0x08` は定義済み
- `src/session.ts`: SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK のスコープ検証で `EMPTY_ALLOWED_PARAMS` を使用
- `src/session.ts`: SUBSCRIBE_TRACKS_OK (REQUEST_OK) 受信処理にはパラメータスコープ検証の呼び出し自体が無い。EXPIRES 許可の前に検証呼び出しの追加が必要

## 設計方針

- SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK 用の許可パラメータ集合を新設し (EXPIRES を含む)、`EMPTY_ALLOWED_PARAMS` の使用箇所を置き換える
- SUBSCRIBE_TRACKS_OK の受信処理にパラメータスコープ検証を追加する
- 受信した EXPIRES 値の扱いは、既存の SUBSCRIBE_OK / REQUEST_UPDATE_OK での処理と同じ方針に揃える (最低限、スコープ検証を通過させて値を破棄しない)
- 仕様参照コメントを draft-19 Section 10.2.15 (EXPIRES Parameter) に更新する

## 完了条件

- EXPIRES 付きの SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK を受信してもセッションが切断されないテストがあること
- 上記 3 メッセージで EXPIRES 以外の未許可パラメータは引き続き ProtocolViolationError になること
- lint / build / typecheck / 既存テストが通ること
