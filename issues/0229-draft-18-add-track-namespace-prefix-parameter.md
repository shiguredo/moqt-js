# TRACK_NAMESPACE_PREFIX メッセージパラメータ (Parameter Type 0x34) が未定義

- Priority: High
- Created: 2026-06-02
- Model: deepseek-v4-pro
- Branch: {Git-Flow のブランチ名}
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-18 §10.2.14 で定義されている TRACK_NAMESPACE_PREFIX (Parameter Type 0x34) がコード上で未定義であり、受信時に PROTOCOL_VIOLATION でセッションが切られる問題を修正する。

## 優先度根拠

仕様で定義されたパラメータの欠落であり、SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の REQUEST_UPDATE において他実装との相互運用に影響するため High。

## 現状

`src/message/types.ts` の `MessageParameterType` に `0x34` のエントリがない。
`src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` に `0x34` のエントリがない。
このパラメータを受信すると `getMessageParameterValueEncoding` が `ProtocolViolationError` をスローする。

## 一次資料の引用

draft-ietf-moq-transport-18 §10.2.14 (TRACK_NAMESPACE_PREFIX Parameter):

> The TRACK_NAMESPACE_PREFIX parameter (Parameter Type 0x34) uses the Track
> Namespace encoding described in Section 2.4.1. It MAY appear in
> REQUEST_UPDATE for a SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS request.

Value エンコーディングは Track Namespace 形式（varint 要素数 + 各要素: varint 長 + バイト列）。

## 設計方針

1. `MessageParameterType` に `TRACK_NAMESPACE_PREFIX: 0x34` を追加
2. `MESSAGE_PARAMETER_VALUE_ENCODING` に対応するエンコーディング種別を追加
   - Track Namespace 形式は既存の uint8/varint/location/length-prefixed のいずれにも該当しないため、新規エンコーディング種別が必要
3. PBT テストでラウンドトリップ検証を追加

## 完了条件

- `MessageParameterType` に `TRACK_NAMESPACE_PREFIX: 0x34` が定義されている
- `MESSAGE_PARAMETER_VALUE_ENCODING` に 0x34 のエントリがある
- `vp run test` 全パス
- `vp run build` 成功
