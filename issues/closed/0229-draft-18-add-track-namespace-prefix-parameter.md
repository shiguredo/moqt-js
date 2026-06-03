# TRACK_NAMESPACE_PREFIX メッセージパラメータ (Parameter Type 0x34) を PBT 用に追加する

- Priority: Low
- Created: 2026-06-02
- Model: deepseek-v4-pro
- Branch: feature/add-track-namespace-prefix-parameter
- Polished: 2026-06-02
- Completed: 2026-06-02

## 目的

draft-ietf-moq-transport-18 §10.2.14 で定義されている TRACK_NAMESPACE_PREFIX (Parameter Type 0x34) を `MessageParameterType` と `MESSAGE_PARAMETER_VALUE_ENCODING` に追加する。

## 優先度根拠

moqt-js はクライアント専用実装であり、0x34 は SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の REQUEST_UPDATE でのみ出現する。クライアントはこれらを送信する側であり、受信するパスが存在しない。したがってランタイムで PROTOCOL_VIOLATION が発生するリスクはない。

本修正の目的は PBT (Property-Based Testing) におけるラウンドトリップテストの完全性確保であり、機能追加ではない。送信パスの実装（namespace prefix の動的更新 API）は将来必要になった時点で別 issue として対応する。以上により Low。

## 一次資料の引用

draft-ietf-moq-transport-18 §10.2.14 (TRACK_NAMESPACE_PREFIX Parameter):

> The TRACK_NAMESPACE_PREFIX parameter (Parameter Type 0x34) uses the Track
> Namespace encoding described in Section 2.4.1. It MAY appear in
> REQUEST_UPDATE for a SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS request.
> It updates the Track Namespace Prefix for that subscription. If the new
> prefix would share a common prefix with another active subscription of
> the same type in the same session, the receiver MUST respond with
> REQUEST_ERROR with error code PREFIX_OVERLAP.

draft-ietf-moq-transport-18 §2.4.1 (Track Naming):

> Track Namespace {
> Number of Track Namespace Fields (vi64),
> Track Namespace Field (..) ...
> }

Track Namespace Field:

> Track Namespace Field {
> Track Namespace Field Length (vi64),
> Track Namespace Field Value (..)
> }

値エンコーディングは Track Namespace 形式であり、これは既存の varint / uint8 / location / length-prefixed のいずれとも異なる。0x34 は偶数型だが、値は varint ではなく Track Namespace encoding である点が特殊。

## 現状

`src/message/types.ts` の `MessageParameterType` に `0x34` のエントリがない。
`src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` に `0x34` のエントリがない。

ランタイムでの受信パスは存在しないが、PBT のラウンドトリップテスト（`parameter.prop.ts`）で 0x34 が生成された場合に `getMessageParameterValueEncoding` が未定義で失敗する。

## 設計方針

### 1. MessageParameterType への追加

`src/message/types.ts` の `MessageParameterType` に以下を追加する。既存の定数は数値順に並んでいるため、0x32 (フォーマット上の最後) の後に追加する。

```typescript
// draft-ietf-moq-transport-18 Section 10.2.14 (TRACK_NAMESPACE_PREFIX Parameter)
TRACK_NAMESPACE_PREFIX: 0x34,
```

### 2. MESSAGE_PARAMETER_VALUE_ENCODING への追加

`src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` に追加する。値型は varint ではない Track Namespace 形式であるため、新規エンコーディング種別 `"track-namespace"` を定義する。

```typescript
// TRACK_NAMESPACE_PREFIX (Section 10.2.14)
0x34: "track-namespace",
```

`MessageParameterValueEncoding` 型に `"track-namespace"` を追加する。

### 3. decodeMessageParameter の分岐追加

`src/message/parameter.ts` の `decodeMessageParameter` に `"track-namespace"` のケースを追加する。既存の `decodeTrackNamespace` (`parameter.ts:259`) が再利用できる。

```typescript
case "track-namespace": {
  const [trackNamespace, consumed] = decodeTrackNamespace(data, offset);
  // ...
}
```

### 4. encodeMessageParameter の分岐追加

対応するエンコード処理も追加する。既存の `encodeTrackNamespace` が利用可能ならそれを使う。

### 5. 送信パスは実装しない

本 issue では受信用のパラメータ定義と PBT テストのみを行う。`REQUEST_UPDATE` + TRACK_NAMESPACE_PREFIX の送信機能は別 issue で対応する。

## テスト戦略

### PBT テスト (parameter.prop.ts)

`src/message/parameter.prop.ts` のパラメータ arb に `0x34` を追加し、"track-namespace" エンコーディングのラウンドトリップ検証を行う。

0x34 が出現するメッセージは REQUEST_UPDATE for SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS のみ。他メッセージの prop ファイルでは 0x34 が出現しないことを確認する。

## 影響範囲

- `src/message/types.ts`: `MessageParameterType` に `TRACK_NAMESPACE_PREFIX: 0x34` を追加
- `src/message/parameter.ts`:
  - `MessageParameterValueEncoding` 型に `"track-namespace"` を追加
  - `MESSAGE_PARAMETER_VALUE_ENCODING` に `0x34: "track-namespace"` を追加
  - `decodeMessageParameter` に `"track-namespace"` ケースを追加
  - `encodeMessageParameter` に対応するケースを追加
- `src/message/parameter.prop.ts`: arb に 0x34 と "track-namespace" の生成ロジックを追加

## 後方互換

- ランタイムの動作に変更なし（受信パスが存在しないため）
- PBT テストの網羅性が向上する

## 完了条件

- `MessageParameterType` に `TRACK_NAMESPACE_PREFIX: 0x34` が定義されている
- `MESSAGE_PARAMETER_VALUE_ENCODING` に `0x34` のエントリがある
- `MessageParameterValueEncoding` 型が `"track-namespace"` を含む
- `decodeMessageParameter` が `"track-namespace"` ケースを処理できる
- `parameter.prop.ts` で 0x34 のラウンドトリップ検証が行われる
- `vp run test` 全パス
- `vp run build` 成功

## 解決方法

moqt-js はクライアント専用実装であり、TRACK_NAMESPACE_PREFIX (0x34) を受信するパスが存在しない（クライアントは SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の REQUEST_UPDATE を送信する側であり受信しない）。したがって実装不要と判断しクローズする。
