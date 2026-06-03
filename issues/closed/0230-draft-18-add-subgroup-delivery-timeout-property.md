# SUBGROUP_DELIVERY_TIMEOUT Track Property (Type 0x06) を追加する

- Priority: High
- Created: 2026-06-02
- Model: deepseek-v4-pro
- Branch: feature/add-subgroup-delivery-timeout-property
- Polished: 2026-06-02
- Completed: 2026-06-03

## 目的

draft-ietf-moq-transport-18 §12.1 で定義されている SUBGROUP_DELIVERY_TIMEOUT Track Property (Type 0x06) を `TrackPropertyId` に追加する。

## 優先度根拠

draft-18 §8 で規定されている delivery timeout 機構の中核をなす Track Property であり、Publisher が timeout 値を設定するために必須。クライアント専用実装でも、Publisher としてこの Property を設定可能にする必要がある。欠落していると他実装との相互運用に支障があるため High。

## 一次資料の引用

draft-ietf-moq-transport-18 §12.1 (SUBGROUP_DELIVERY_TIMEOUT):

> SUBGROUP_DELIVERY_TIMEOUT (Property Type 0x06) is a Track Property. It is a varint.

draft-ietf-moq-transport-18 §8 (Delivery Timeouts and Data Reliability):

> The publisher communicates both timeout values as a Track Property;
> the subscriber communicates them as Message Parameters.

値の単位はミリ秒。0 はタイムアウトなしを意味する。仕様上、値域の上限は定義されていない。

## 現状

`src/properties.ts:51-83` の `TrackPropertyId` に `0x06` がない。`decodeProperties` / `parseProperties` は汎用的な KVP ループで任意の Property ID を処理できるため、0x06 を受信してもエラーにはならないが、値の意味をコードが認識できず、`getTrackProperty` で取得できない。

## 設計方針

### 1. TrackPropertyId への追加

`src/properties.ts` の `TrackPropertyId` に以下を追加する。数値順で `0x04` (MAX_CACHE_DURATION) と `0x0e` (DEFAULT_PUBLISHER_PRIORITY) の間に挿入する。

```typescript
// draft-ietf-moq-transport-18 Section 12.1
SUBGROUP_DELIVERY_TIMEOUT: 0x06n,
```

### 2. エンコード/デコードへの影響

エンコード/デコードは既存の汎用 KVP ループが処理するため、`decodeProperties` / `encodeProperty` / `validateTrackPropertyValue` への変更は不要。偶数 ID なので Value は varint として自動処理される。

### 3. 状態管理上の影響

Subscribe / Fetch の状態管理ロジックへの影響はない。本 Property は relay が timeout 判断に使用するものであり、クライアント側の状態機械には直接関与しない。

### 4. 関連 issue

- Message Parameter 側の SUBGROUP_DELIVERY_TIMEOUT (0x06) は issue 0228 で対応
- 0x02 の `OBJECT_DELIVERY_TIMEOUT` への改名と DELIVERY_TIMEOUT 分割は issue 0208 で対応

## テスト戦略

### 単体テスト (properties.test.ts)

`TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT` が `0x06n` であることを確認。

### PBT テスト (properties.prop.ts)

`generateTrackPropertyId` に `0x06` を追加し、生成された Property ID でエンコード/デコードのラウンドトリップテストを行う。

## 影響範囲

- `src/properties.ts`: `TrackPropertyId` に `SUBGROUP_DELIVERY_TIMEOUT: 0x06n` を追加
- `src/properties.test.ts`: 定数値確認テストを追加
- `src/properties.prop.ts`: arb に 0x06 を追加

## 後方互換

- 新規定数の追加のみであり、既存の動作に影響なし。後方互換あり
- 既存の `DELIVERY_TIMEOUT: 0x02n` は維持する（改名は 0208 の範囲）

## 完了条件

- `TrackPropertyId` に `SUBGROUP_DELIVERY_TIMEOUT: 0x06n` が定義されている
- `properties.test.ts` に定数値確認テストがある
- `vp run test` 全パス
- `vp run build` 成功

## 解決方法

### 変更ファイル

- `src/properties.ts`: `TrackPropertyId` に `SUBGROUP_DELIVERY_TIMEOUT: 0x06n` を追加（0x04 と 0x0E の間、数値順）
- `src/properties.test.ts`: 定数値確認テストを追加 (`TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT は 0x06n である`)

### 未変更のファイル（意図的）

- `src/properties.prop.ts`: `unknownExtensionIdArb` の filter は値域制約のある Property ID のみを除外する設計のため、SUBGROUP_DELIVERY_TIMEOUT は除外不要（値域制約なし）。PBT の既存 arb で自然にカバーされる。

### テスト

- `vp run test` 全 587 テスト通過
- `vp run build` 成功
