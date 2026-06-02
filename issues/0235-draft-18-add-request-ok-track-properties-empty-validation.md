# REQUEST_OK の PUBLISH_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK 応答で Track Properties が空であることを検証する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/add-request-ok-empty-track-properties-validation
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 §10.5 に基づき、PUBLISH_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK の REQUEST_OK 応答で Track Properties が空でない場合に `PROTOCOL_VIOLATION` でセッションを閉じる検証を追加する。

## 優先度根拠

§10.5 で MUST レベルの規定であり、違反時に適切にセッションを閉じないとプロトコル準拠に欠ける。ただし実運用上は対向が Track Properties 付きの REQUEST_OK を送るケースは稀であり、実害は限定的なため Medium。

## 一次資料の引用

draft-ietf-moq-transport-18 §10.5 (REQUEST_OK):

> Track Properties are populated in TRACK_STATUS_OK; they are empty in PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK. If an endpoint receives Track Properties in one of these messages it MUST close the session with a PROTOCOL_VIOLATION.

## 現状

`src/message/publish.ts:174-186` の `decodePublishOkPayload` は Track Properties のデコード後、空チェックを行っていない。

`src/message/session.ts:290-302` の `decodeRequestOkPayload` も同様に空チェックがない。`decodeRequestOkPayload` は REQUEST_OK 全種類の共通デコード関数であるため、呼び出し側で応答の種類に応じた検証が必要。

## 設計方針

### 1. decodePublishOkPayload での検証

`decodePublishOkPayload` でデコード後に `trackProperties.length > 0` の場合、`ProtocolViolationError` をスローする。

### 2. decodeRequestOkPayload での検証

汎用の `decodeRequestOkPayload` では、呼び出し元が検証を制御できるようにするため、以下のいずれかの方式を選択:

**方式 A**: `decodeRequestOkPayload` に `allowTrackProperties` フラグ引数を追加し、false 時に空でなければエラーとする。

**方式 B**: `decodeRequestOkPayload` は Track Properties のデコードのみ行い、検証は各呼び出し元（`handleRequestOk` 等）で行う。

方式 B が責務分離の観点で望ましい。`handleRequestOk` でリクエスト種別に応じて検証する。

### 3. 対象メッセージの特定

コードベースで以下の REQUEST_OK 応答をデコードする箇所全 4 種を洗い出し、TRACK_STATUS 応答以外で Track Properties が空であることを検証する:

- PUBLISH_OK (publish.ts)
- REQUEST_UPDATE_OK (session.ts / bidi.ts)
- SUBSCRIBE_NAMESPACE_OK (namespace 系の応答処理)
- PUBLISH_NAMESPACE_OK (namespace 系の応答処理)

## 影響範囲

- `src/message/publish.ts`: `decodePublishOkPayload` に空チェックを追加
- `src/message/session.ts`: `decodeRequestOkPayload` の呼び出し元での検証追加
- `src/session.ts` / `src/session/bidi.ts`: `handleRequestOk` でのリクエスト種別に応じた検証追加
- PBT テスト: 非空 Track Properties を含む不正な REQUEST_OK のテスト追加

## 完了条件

- PUBLISH_OK の REQUEST_OK 応答で Track Properties が空でない場合に ProtocolViolationError が発生する
- REQUEST_UPDATE_OK の REQUEST_OK 応答で Track Properties が空でない場合に ProtocolViolationError が発生する
- SUBSCRIBE_NAMESPACE_OK の REQUEST_OK 応答で Track Properties が空でない場合に ProtocolViolationError が発生する
- PUBLISH_NAMESPACE_OK の REQUEST_OK 応答で Track Properties が空でない場合に ProtocolViolationError が発生する
- TRACK_STATUS_OK の REQUEST_OK 応答では Track Properties が許容される
- 該当テストが追加されている
- `vp run test` 全パス
- `vp run build` 成功
