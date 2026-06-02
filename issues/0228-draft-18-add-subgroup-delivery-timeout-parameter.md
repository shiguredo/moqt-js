# SUBGROUP_DELIVERY_TIMEOUT メッセージパラメータ (Parameter Type 0x06) が未定義

- Priority: High
- Created: 2026-06-02
- Model: deepseek-v4-pro
- Branch: {Git-Flow のブランチ名}
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-18 §10.2.3 で定義されている SUBGROUP_DELIVERY_TIMEOUT (Parameter Type 0x06) がコード上で未定義であり、受信時に PROTOCOL_VIOLATION でセッションが切られる問題を修正する。

## 優先度根拠

仕様で定義された必須パラメータの欠落であり、他実装との相互運用に致命的な影響があるため High。

## 現状

`src/message/types.ts` の `MessageParameterType` に `0x06` のエントリがない。
`src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` に `0x06` のエントリがない。
このパラメータを受信すると `getMessageParameterValueEncoding` が `ProtocolViolationError` をスローする。

## 一次資料の引用

draft-ietf-moq-transport-18 §10.2.3 (SUBGROUP_DELIVERY_TIMEOUT Parameter):

> The SUBGROUP_DELIVERY_TIMEOUT parameter (Parameter Type 0x06) is a varint.
> It MAY appear in a PUBLISH_OK, SUBSCRIBE, or REQUEST_UPDATE message.

Value エンコーディングは varint (整数値)。

## 設計方針

1. `MessageParameterType` に `SUBGROUP_DELIVERY_TIMEOUT: 0x06` を追加
2. `MESSAGE_PARAMETER_VALUE_ENCODING` に対応するエンコーディング種別を追加 (varint)
3. PBT テストでラウンドトリップ検証を追加

## 完了条件

- `MessageParameterType` に `SUBGROUP_DELIVERY_TIMEOUT: 0x06` が定義されている
- `MESSAGE_PARAMETER_VALUE_ENCODING` に 0x06 のエントリがある
- `vp run test` 全パス
- `vp run build` 成功
