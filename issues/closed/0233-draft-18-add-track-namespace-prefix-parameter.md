# TRACK_NAMESPACE_PREFIX Message Parameter (Type 0x34) を追加する

- Priority: High
- Created: 2026-06-03
- Completed: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/add-track-namespace-prefix-parameter
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 §10.2.14 で定義されている TRACK_NAMESPACE_PREFIX (Parameter Type 0x34) を追加する。現在は `MessageParameterType` と `MESSAGE_PARAMETER_VALUE_ENCODING` に未定義のため、受信時に `getMessageParameterValueEncoding(0x34)` が `ProtocolViolationError` をスローする。

## 優先度根拠

仕様で定義されたパラメータの欠落であり、REQUEST_UPDATE で SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の Track Namespace Prefix を更新する際に必須のパラメータ。他実装との相互運用に支障があるため High。

## 一次資料の引用

draft-ietf-moq-transport-18 §10.2.14 (TRACK_NAMESPACE_PREFIX Parameter):

> The TRACK_NAMESPACE_PREFIX parameter (Parameter Type 0x34) uses the Track Namespace encoding described in Section 2.4.1.

draft-ietf-moq-transport-18 §15.7 (Message Parameters IANA registry):

> 0x34 | TRACK_NAMESPACE_PREFIX | Section 10.2.14

## 現状

`src/message/types.ts` の `MessageParameterType` に 0x34 のエントリがない（末尾は 0x32 NEW_GROUP_REQUEST）。

`src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` に 0x34 のエントリがない。

## 設計方針

### 1. MessageParameterType への追加

`src/message/types.ts` の `MessageParameterType` に以下を追加する。数値順で 0x32 (NEW_GROUP_REQUEST) の後に挿入する。

```typescript
/**
 * TRACK_NAMESPACE_PREFIX (Section 10.2.14 TRACK_NAMESPACE_PREFIX Parameter)
 *
 * draft-ietf-moq-transport-18:
 * REQUEST_UPDATE で SUBSCRIBE_NAMESPACE または SUBSCRIBE_TRACKS の
 * Track Namespace Prefix を更新するために使用する。
 * 値は Track Namespace エンコーディング。
 * draft-ietf-moq-transport-18 Section 10.2.14
 */
TRACK_NAMESPACE_PREFIX: 0x34,
```

### 2. MESSAGE_PARAMETER_VALUE_ENCODING への追加

Track Namespace は独自の構造 (varint count + 各フィールドが varint length + bytes) を持つが、Message Parameter の Value としてはエンコード済みのバイト列を保持する。既存の "length-prefixed" で扱い、`encodeTrackNamespace` / `decodeTrackNamespace` でバイト列⇔`TrackNamespace` の変換を行う。

```typescript
// TRACK_NAMESPACE_PREFIX (Section 10.2.14)
0x34: "length-prefixed",
```

### 3. decodeMessageParameter の対応

0x34 は "length-prefixed" のため既存のデコードロジックで bytes として読み取れる。上位レイヤーで `decodeTrackNamespace` を使って `TrackNamespace` に変換する。

`getParameterTrackNamespace` ヘルパーを `parameter.ts` に追加し、パラメータ値から `TrackNamespace` を抽出する。`encodeParameterTrackNamespace` も対称的に追加する。

### 4. PBT 対応

PBT の arb に 0x34 を追加する。出現可能なメッセージは REQUEST_UPDATE であり、`src/message/subscribe.prop.ts` の `namespaceParameterArb`（または新設）でカバーする。

## 影響範囲

- `src/message/types.ts`: `MessageParameterType` に `TRACK_NAMESPACE_PREFIX: 0x34` を追加
- `src/message/parameter.ts`: `MESSAGE_PARAMETER_VALUE_ENCODING` に `0x34: "length-prefixed"` を追加、`getParameterTrackNamespace` / `encodeParameterTrackNamespace` ヘルパー追加
- `src/message/subscribe.prop.ts`: PBT arb の `lengthPrefixedParameterArb` に 0x34 を追加
- `src/message/parameter.prop.ts`: コメントと arb を更新

## 後方互換

- 受信側: 既存の未知パラメータによる PROTOCOL_VIOLATION が 0x34 に対して発生しなくなる。後方互換あり
- 送信側: 本 issue では送信機能は必須としない（定数定義と受信対応が優先）

## 完了条件

- `MessageParameterType` に `TRACK_NAMESPACE_PREFIX: 0x34` が定義されている
- `MESSAGE_PARAMETER_VALUE_ENCODING` に 0x34 のエントリがある
- `decodeMessageParameter(0x34)` が Track Namespace を正しくデコードする
- PBT テストが 0x34 をカバーしている
- `vp run test` 全パス
- `vp run build` 成功

## 解決方法

### 変更ファイル

- `src/message/types.ts`: `MessageParameterType` に `TRACK_NAMESPACE_PREFIX: 0x34` を追加
- `src/message/parameter.ts`: `MESSAGE_PARAMETER_VALUE_ENCODING` に `0x34: "length-prefixed"` を追加、`encodeParameterTrackNamespace` / `getParameterTrackNamespace` ヘルパーを追加
- `src/message/index.ts`: 新規ヘルパーを export に追加
- `src/message/parameter.prop.ts`: `lengthPrefixedParameterArb` に `0x34` を追加
- `src/message/subscribe.prop.ts`: `lengthPrefixedParameterArb` に `0x34` を追加

### テスト

- `vp run test` 全 590 テスト通過
- `vp run build` 成功
