# Track Property の値域が MUST レベルで検証されていない

Created: 2026-05-02
Completed: 2026-05-03
Model: Opus 4.7

## 概要

draft-17 §11 で定義されている Track Property のうち、値域に MUST レベルの制約があるものを実装が検証していない。

- DEFAULT_PUBLISHER_PRIORITY (0x0E) — 値は 0–255 (8bit)
- DEFAULT_PUBLISHER_GROUP_ORDER (0x22) — 値は 0x1 / 0x2 のみ
- DYNAMIC_GROUPS (0x30) — 値は 0 / 1 のみ

`src/properties.ts` の Property デコード経路はいずれも `decodeVarint` で読むだけで、上記の MUST チェックを行っていない。

## RFC 根拠

draft-ietf-moq-transport-17:

- §11.3 DEFAULT_PUBLISHER_PRIORITY (line 5351-5360):

  > DEFAULT PUBLISHER PRIORITY (Property Type 0x0E) is a Track Property that specifies the priority of a subscription relative to other subscriptions in the same session. The value is from 0 to 255 and lower numbers get higher priority. See Section 7. Priorities above 255 are invalid.

- §11.4 DEFAULT_PUBLISHER_GROUP_ORDER (line 5362-5371):

  > The allowed values are Ascending (0x1) or Descending (0x2). If an endpoint receives a value outside this range, it MUST close the session with PROTOCOL_VIOLATION.

- §11.5 DYNAMIC_GROUPS (line 5383-5390):

  > The allowed values are 0 or 1. ... If an endpoint receives a value larger than 1, it MUST close the session with PROTOCOL_VIOLATION.

## 該当箇所

- `src/properties.ts` の Property デコードロジック (TrackPropertyId / MOQTPropertyId に対応する decode 部分)
- `src/message/parameter.ts:137` `validateGroupOrderValue` は Message Parameter 用に既にあるが、Track Property の 0x22 経路には適用されていない
- Publisher Priority の uint8 範囲チェックも無し

## 期待される動作

各 Property のデコード時に値域を検証し、外れていたら `ProtocolViolationError` を throw、上位ループで `PROTOCOL_VIOLATION` セッション終了に翻訳する。`validateGroupOrderValue` を Track Property 経路でも再利用する。

## 優先度

重要。MUST 違反であり、不正な peer のプロパティで状態が壊れる。

## 解決方法

- `src/properties.ts` に `validateTrackPropertyValue(id, value)` を新設し、`PUBLISHER_PRIORITY` / `PUBLISHER_GROUP_ORDER_PREFERENCE` / `DYNAMIC_GROUPS` の値域を検証する。違反時は `ProtocolViolationError` を throw する
- `decodeProperties` / `parseProperties` (generic な「未知の拡張」経路) / `decodeImmutableProperties` / `parseProperties` 内の Immutable Extensions 内部処理の **すべての偶数 ID 経路** で `validateTrackPropertyValue` を呼び出す
- `validateGroupOrderValue` (Message Parameter 用) の再利用は行わず、Track Property 用に独立して実装した (Message Parameter 側は `Error` を throw する別ロジックで、Track Property の値域も Group Order Preference 含めて 1 つの validator にまとめた方が見通しが良いため)
- `src/properties.test.ts` に以下のテストを追加: `validateTrackPropertyValue` の単体テスト (3 Property × 許容値 / 不正値) / `decodeProperties` / `parseProperties` / `decodeImmutableProperties` の不正値で `ProtocolViolationError` が throw される検証
- 影響を受ける PBT (`properties.prop.ts` / `publish.prop.ts` / `subscribe.prop.ts` / `fetch.prop.ts`) で Track Property ID (`PUBLISHER_PRIORITY` / `PUBLISHER_GROUP_ORDER_PREFERENCE` / `DYNAMIC_GROUPS`) を arbitrary の id 集合から除外し、ラウンドトリップ生成時に validate が必ず通るようにした
- `encodeProperties` 側は触っていない (Subscriber が自分で生成した Track Property を encode する際には `Property` 型のまま使い、API として値域の事前チェックを強制すべきかは別 issue とする)
