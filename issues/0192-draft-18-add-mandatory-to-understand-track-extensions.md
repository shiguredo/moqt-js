# Mandatory-to-Understand な Property/Parameter を拒否する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Properties と Parameters に "mandatory-to-understand" の概念が追加された。
未知の mandatory-to-understand 拡張を受信した場合、エラー応答を返す必要がある。

> An endpoint that receives a mandatory-to-understand [Property|Parameter]
> it does not recognize MUST [close the session|respond with a
>
> > REQUEST_ERROR].
>
> -- draft-ietf-moq-transport-18 §4

mandatory かどうかは Property/Parameter Type の最上位ビット (0x80) で判定する。

## 変更内容

### 1. Property デコード時に mandatory ビットを判定する (`src/properties.ts`)

- `decodeProperties()` で各 Property Type の最上位ビット (0x80) をチェックする
- 未知の mandatory Property (Type & 0x80 かつ未知 ID) を受信した場合、
  `MalformedTrackError` または `ProtocolViolationError` を throw する
- 既知の Property Type との突合ロジックを実装する
  - `MOQTPropertyId` / `TrackPropertyId` の既知 ID リストに対してチェックする

### 2. Parameter デコード時に mandatory ビットを判定する (`src/message/parameter.ts`)

- `decodeParameters()` で各 Parameter Type の最上位ビット (0x80) をチェックする
- 未知の mandatory Parameter を受信した場合、`ProtocolViolationError` を throw する
- `MessageParameterType` の既知 ID リストに対してチェックする

### 3. mandatory ビット判定ヘルパーを新設する

- `isMandatoryProperty(type: number): boolean` を新設する
- `isMandatoryParameter(type: number): boolean` を新設する

## 該当箇所

| ファイル                           | 変更内容                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `src/properties.ts:560-684`        | `parseProperties` / `decodeProperties` に mandatory ビット判定を追加する |
| `src/message/parameter.ts:558-737` | `decodeParameters` に mandatory ビット判定を追加する                     |
| `src/properties.ts` (新設)         | `isMandatoryProperty()` ヘルパーを追加する                               |

## テスト方針

- `src/properties.test.ts`: 未知の mandatory Property (Type=0x80+未知) でエラーが throw されることを検証する
- `src/message/parameter.test.ts`: 未知の mandatory Parameter でエラーが throw されることを検証する
- 既知の mandatory Property/Parameter は正常にデコードされることを検証する

## 影響範囲

- 既存の Property/Parameter Type と mandatory ビットの重なりを確認する（既存 ID は全て 0x80 未満か）
- 将来、Property/Parameter Type が 0x80 以上になった場合の挙動が変わる
