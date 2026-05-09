# session.ts の pure function 化を完了し fast-check PBT を追加する

Created: 2026-05-09
Model: deepseek-v4-pro

## 概要

`src/session.ts` (4,453 行) の inline ロジックの一部は既に module-level の純粋関数として export 済みだが、以下の問題が残っている:

1. **session.ts 内の呼び出し箇所が新しい純粋関数を使っていない** — `publish()`, `subscribe()` が inline のまま
2. **抽出済みの純粋関数に PBT がない** — `buildSubscribeParameters`, `buildPublishTrackProperties`, `calculateObjectIdDelta` 等
3. **未抽出のロジックがまだある** — メッセージ構築、Subgroup 状態遷移、Fetch context 永続化

## 既に抽出済みの純粋関数

以下の関数は既に `src/session.ts` に `export function` として存在する（PBT 未作成）:

| 関数                                     | セクション | 概要                                  |
| ---------------------------------------- | ---------- | ------------------------------------- |
| `buildPublishParameters(options)`        | L4216      | PUBLISH の Message Parameters 構築    |
| `buildPublishTrackProperties(options)`   | L4244      | PUBLISH の Track Properties 構築      |
| `buildSubscribeParameters(options)`      | L4296      | SUBSCRIBE の Message Parameters 構築  |
| `extractLargestLocation(parameters)`     | L4370      | SUBSCRIBE_OK から LARGEST_OBJECT 抽出 |
| `extractForwardState(parameters)`        | L4383      | パラメータから FORWARD 状態抽出       |
| `validateFetchOkEndLocation(start, end)` | L4398      | FETCH_OK End Location 検証            |
| `classifyIncomingStreamType(firstByte)`  | L4421      | 単方向ストリーム種別判定              |
| `calculateObjectIdDelta(prevId, curId)`  | L4448      | Object ID Delta 計算                  |

## 残作業

### Phase 1: inline コードを純粋関数呼び出しに置き換える

`src/session.ts` 内の `publish()`, `subscribe()` のパラメータ構築を、既存の純粋関数呼び出しに置き換える。

**変更箇所**:

| メソッド                  | 対象                 | 置き換え前                   | 置き換え後                                     |
| ------------------------- | -------------------- | ---------------------------- | ---------------------------------------------- |
| `publish()`               | Message Parameters   | L1080-1098 (inline)          | `buildPublishParameters(options)`              |
| `publish()`               | Track Properties     | L1100-1151 (inline)          | `buildPublishTrackProperties(options)`         |
| `subscribe()`             | Message Parameters   | L1282-1341 (inline)          | `buildSubscribeParameters(options)`            |
| `readSubscribeResponse()` | LARGEST_OBJECT 抽出  | L2939-2946 (inline for loop) | `extractLargestLocation(decoded.parameters)`   |
| `readPublishResponse()`   | FORWARD 抽出         | L2881-2889 (inline for loop) | `extractForwardState(decoded.parameters)`      |
| `readFetchResponse()`     | End Location 検証    | L3055-3069 (inline)          | `validateFetchOkEndLocation(startLoc, endLoc)` |
| `handleIncomingStream()`  | ストリーム種別判定   | L3728-3798 (inline)          | `classifyIncomingStreamType(streamType)`       |
| `sendObjectInternal()`    | Object ID Delta 計算 | L2451-2452 (inline)          | `calculateObjectIdDelta(prevId, curId)`        |

### Phase 2: PBT テストファイルを作成する

新規ファイル: `src/session.prop.ts`

```typescript
import { test, assert } from "vite-plus/test";
import fc from "fast-check";
```

#### PBT 1: `buildPublishParameters` + `buildPublishTrackProperties`

- **Property**: 任意の `PublishOptions` (expires, forward, deliveryTimeout, maxCacheDuration, publisherPriority, groupOrder, dynamicGroups) → 生成された `Parameter[]` + `Property[]` がそれぞれの encode/decode ラウンドトリップで元と一致する
- **RFC**: §9.3.8, §9.3.10, §11.1-§11.5

#### PBT 2: `buildSubscribeParameters`

- **Property**: 任意の `SubscribeOptions` (filter, deliveryTimeout, subscriberPriority, groupOrder, newGroupRequest, rendezvousTimeout, forward) → 生成された `Parameter[]` が encode/decode ラウンドトリップで元と一致する
- **RFC**: §9.3.3-§9.3.7, §9.3.10-§9.3.11
- **エッジケース**: `subscriberPriority` が 0-255 の範囲内であること、`groupOrder` が 0x01/0x02 であること

#### PBT 3: `extractLargestLocation`

- **Property**: `Parameter[]` に `LARGEST_OBJECT` が含まれている場合、抽出結果の Location が元のエンコード値と一致する。含まれていない場合は `undefined`
- **RFC**: §9.3.9

#### PBT 4: `extractForwardState`

- **Property**: `FORWARD` が含まれている場合はその値 (0→false, 1→true)、含まれていない場合は `true`
- **RFC**: §9.3.10

#### PBT 5: `validateFetchOkEndLocation`

- **Property**: 任意の Location ペア → `end < start` の場合のみエラー文字列が返る。それ以外は `undefined`
- **RFC**: §9.15

#### PBT 6: `classifyIncomingStreamType`

- **Property**: 全値域の `BigInt` → `0x05` なら `"fetch"`、`0x10-0x1F/0x30-0x3F` なら `"subgroup"`、それ以外は `"unknown"`
- **エッジケース**: 境界値 `0x10`, `0x1F`, `0x30`, `0x3F`

#### PBT 7: `calculateObjectIdDelta`

- **Property**: 任意の `(prevId, curId)` ペア
  - `prevId < 0n` の場合、delta === curId（初回オブジェクト）
  - `prevId >= 0n && curId > prevId` の場合、`prevId + delta + 1n === curId`（RFC §10.4.2 の計算式）
- **RFC**: §10.4.2

### Phase 3: 未抽出ロジックの純粋関数化（将来 issue 候補）

以下の処理は本 issue では扱わず、必要に応じて別 issue で対応する:

- **メッセージ構築関数** (`buildPublishMessage` 等): 現状の inline 構築は `as Parameters<typeof encodeXxxPayload>[0]` の型アサーションに頼っている。`encodeXxxPayload` の引数型と一致するメッセージ型を定義し、純粋な構築関数に抽出する
- **Subgroup 状態遷移** (`nextSubgroupSendState`): `sendObjectInternal` のストリーム作成判定は `publisherStreams` Map に依存しており、純粋関数化には状態機械としての再設計が必要
- **Fetch context 永続化** (`processFetchObjectsPure`): `processFetchObjects` の統計カウンター更新 (`this.statsObjectsReceivedViaFetch` 等) を戻り値に含める設計判断が必要

## 完了条件

- `publish()` / `subscribe()` が既存の純粋関数を呼び出すように置き換えられている
- 他の inline ロジック (LARGEST_OBJECT 抽出、FORWARD 抽出、End Location 検証、ストリーム種別判定、Object ID Delta 計算) も置き換えられている
- `src/session.prop.ts` に PBT 1〜7 が実装されている
- 全既存テスト (433 tests) が通過している
- 型チェックが通過している

## 優先度

高。session.ts の純粋ロジックが未テストのまま残っており、特にパラメータ構築の uint8/value 範囲や Object ID Delta の計算式は E2E テストでは網羅的に検証できない。

## 非ゴール

- 新たな純粋関数の作成 (Phase 3 の項目は含まない)
- session.ts のクラス分割
- パフォーマンス最適化
