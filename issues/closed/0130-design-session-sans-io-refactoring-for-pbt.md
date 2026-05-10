# session.ts の inline ロジックを純粋関数呼び出しに置き換え PBT を追加する

Created: 2026-05-09
Completed: 2026-05-10
Model: DeepSeek v4-pro

## 概要

`src/session.ts` (4,453 行) には既に 8 つの純粋関数が `export` されているが、以下の問題が残っている:

1. **呼び出し箇所が inline のまま**: `publish()`, `subscribe()`, `readPublishResponse()`, `readSubscribeResponse()`, `readFetchResponse()`, `sendObjectInternal()` の 6 メソッドで純粋関数と同じロジックを inline 記述している
2. **抽出済みの純粋関数に PBT がない**: パラメータ構築、値抽出、位置検証、ID Delta 計算の網羅的検証が未実施

Phase 1 は動作変更を一切伴わない純粋リファクタリングである。inline コードと純粋関数のロジックは完全に同一であり、呼び出しへの置き換えのみを行う。Phase 2 で新設する PBT により、これらのロジックを網羅的に検証する。

対象の 8 関数: `buildPublishParameters`, `buildPublishTrackProperties`, `buildSubscribeParameters`, `extractLargestLocation`, `extractForwardState`, `validateFetchOkEndLocation`, `classifyIncomingStreamType`, `calculateObjectIdDelta`

## 変更対象ファイル

- `src/session.ts`（既存修正）: 6 メソッドの inline コードを純粋関数呼び出しに置き換え
- `src/session.prop.ts`（新規作成）: 8 関数の PBT。既存の `src/message/session.prop.ts`（GOAWAY / REQUEST_OK / REQUEST_ERROR のメッセージエンコード PBT）とはテスト対象とディレクトリが異なり重複しない

## Phase 1: inline コードを純粋関数呼び出しに置き換える

全置き換えで動作変更は発生しない。inline コードと各純粋関数のロジックは完全同一である。置き換え後は各メソッド内の該当コードブロックを削除し、純粋関数呼び出しの代入に置き換える。

| メソッド                                         | 置き換え前（inline コード範囲） | 置き換え後                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publish()` の Message Parameters                | `session.ts:1081-1098`          | `const parameters = buildPublishParameters(options)`                                                                                                                                                                                                                                                                                                                                                |
| `publish()` の Track Properties                  | `session.ts:1100-1151`          | `const trackProperties = buildPublishTrackProperties(options)`                                                                                                                                                                                                                                                                                                                                      |
| `subscribe()` の Message Parameters              | `session.ts:1282-1341`          | `const parameters = buildSubscribeParameters(options)`                                                                                                                                                                                                                                                                                                                                              |
| `readSubscribeResponse()` の LARGEST_OBJECT 抽出 | `session.ts:2939-2946`          | `const largestLocation = extractLargestLocation(decoded.parameters)`                                                                                                                                                                                                                                                                                                                                |
| `readPublishResponse()` の FORWARD 抽出          | `session.ts:2881-2888`          | `const forwardState = extractForwardState(decoded.parameters)`（配下の `pending.impl.setForwardState(forwardState)` は維持）。`extractForwardState` が内部で `validateForwardValue` 経由で `ProtocolViolationError` を throw した場合、既存の try/catch 節 (`session.ts:2910`) が捕捉し inline コードと同一の reject 処理を行うため動作変更はない                                                   |
| `readFetchResponse()` の End Location 検証       | `session.ts:3055-3071`          | `const errorMessage = validateFetchOkEndLocation(startLoc, endLoc)` を呼び出す。`pending.startLocation` が `undefined` の場合は呼び出しをスキップする（実装コードでは `if (pending.startLocation)` の truthy check）。戻り値が文字列の場合は `SessionError(PROTOCOL_VIOLATION)` を生成し、`pendingFetch.delete(requestId)` + `pending.reject(error)` + `closeWithError(error)` の既存処理を維持する |
| `sendObjectInternal()` の Object ID Delta 計算   | `session.ts:2451-2452`          | `const objectIdDelta = calculateObjectIdDelta(streamState.previousObjectId, objectId)`                                                                                                                                                                                                                                                                                                              |

`handleIncomingStream()` のストリーム種別判定は置き換えない。予約型 (0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F) の PROTOCOL_VIOLATION 送出責務が呼び出し側にあり、`classifyIncomingStreamType` はあくまで「実装側」の判別のみを返すため、`handleIncomingStream` 内の予約型チェックと組み合わせた既存構造を維持する。

## Phase 2: PBT テストファイルを作成する

新規ファイル: `src/session.prop.ts`

すべての PBT は Vitest の Chai API（`test` / `assert`）を使用し、`describe` / `it` / `expect` は使用しない。

PBT 1, 2 では `encodeParameters`（`src/message/parameter.ts`） / `decodeParameters`（`src/message/parameter.ts`）と `encodeProperties`（`src/properties.ts`） / `decodeProperties`（`src/properties.ts`）を用いたラウンドトリップ検証を行う。`decodeParameters` は `[Parameter[], number]` を返すため、`const [decoded, _] = decodeParameters(encoded)` で destructure する。`decodeProperties` は `Property[]` を返す。ソースコードと同じ型の変数を用い、deep equal で一致を検証する。

`parameter.prop.ts` が Parameter 単体のエンコードを検証しているのに対し、本 PBT は `PublishOptions` / `SubscribeOptions` から構築された Parameter / Property の整合性を検証するため重複しない。Parameter 構築のみを検証し、メッセージ全体（Track Namespace, Track Name 等を含むペイロード）の envelope 検証は非ゴールである。

### PBT 共通: Arbitrary 定義方針

- `PublishOptions` の arbitrary: `fc.record()` 内の各フィールドを `fc.option(arb, { nil: undefined })` でラップする。既存の全 `.prop.ts` と同様に第二引数 `{ nil: undefined }` を指定する
  - `expires`: `fc.option(fc.bigInt({min: 0n, max: 1000000n}))`
  - `deliveryTimeout`: `fc.option(fc.bigInt({min: 0n, max: 1000000n}))`
  - `maxCacheDuration`: `fc.option(fc.bigInt({min: 0n, max: 1000000n}))`
  - `publisherPriority`: `fc.option(fc.integer({min: 0, max: 255}))`
  - `groupOrder`: `fc.option(fc.constantFrom("Ascending" as const, "Descending" as const))`
  - `dynamicGroups`: `fc.option(fc.boolean())`
  - `forward`: `fc.option(fc.boolean())`
- `SubscribeOptions` の arbitrary: `fc.record()` 内の各フィールドを `fc.option(arb, { nil: undefined })` でラップする
  - `filter`: `fc.option(fc.oneof(...))` で `SubscriptionFilter` の 4 バリアントを生成する。詳細は後述の `SubscriptionFilter` 任意構築を参照
  - `deliveryTimeout`: `fc.option(fc.bigInt({min: 0n, max: 1000000n}))`
  - `subscriberPriority`: `fc.option(fc.integer({min: 0, max: 255}))`
  - `groupOrder`: `fc.option(fc.constantFrom("Ascending" as const, "Descending" as const))`
  - `newGroupRequest`: `fc.option(fc.bigInt({min: 0n, max: 1000000n}))`
  - `rendezvousTimeout`: `fc.option(fc.bigInt({min: 0n, max: 1000000n}))`
  - `forward`: `fc.option(fc.boolean())`
- `Location` の raw arbitrary（`SubscriptionFilter` や `validateFetchOkEndLocation` で使用）:
  ```typescript
  const locationArb = fc.record({
    group: fc.bigInt({ min: 0n, max: 1000000n }),
    object: fc.bigInt({ min: 0n, max: 1000000n }),
  });
  ```
- `Location` の encoded arbitrary（`LARGEST_OBJECT` Parameter value の構築で使用）: `locationArb.map((loc) => encodeLocation(loc))` で VLS エンコードする。`encodeLocation` は `src/message/parameter.ts` の export。既存の `src/message/session.prop.ts` の `locationParameterArb` を参考にする
- `Parameter[]` の任意構築（PBT 3/4 で使用）:
  - varint 型 (0x02 DELIVERY_TIMEOUT, 0x04 RENDEZVOUS_TIMEOUT, 0x08 EXPIRES, 0x32 NEW_GROUP_REQUEST): `encodeVarint` で value を構築
  - uint8 型 (0x10 FORWARD, 0x20 SUBSCRIBER_PRIORITY, 0x22 GROUP_ORDER): `new Uint8Array([byteValue])` で 1 バイト構築。`encodeUint8ParameterValue` と整合させる
  - LARGEST_OBJECT (0x09): `encodeLocation({ group, object })` で VLS エンコードした value を構築

### SubscriptionFilter の任意構築

PBT 2 の `SubscribeOptions.filter` に必要な `SubscriptionFilter` の arbitrary。`encodeSubscriptionFilterParameter` (`src/message/parameter.ts`) が 4 バリアントをエンコードする。各バリアントを `fc.oneof` で構築する:

- `{ type: "NextGroupStart" }` — 単純
- `{ type: "LargestObject" }` — 単純
- `{ type: "AbsoluteStart"; startLocation: Location }` — Location の任意生成が必要
- `{ type: "AbsoluteRange"; startLocation: Location; endGroupDelta: bigint }` — Location + bigint の任意生成が必要

```typescript
// locationArb は前節「Location の raw arbitrary」で定義済み
const subscriptionFilterArb = fc.oneof(
  fc.constant({ type: "NextGroupStart" as const }),
  fc.constant({ type: "LargestObject" as const }),
  locationArb.map((startLocation) => ({ type: "AbsoluteStart" as const, startLocation })),
  fc
    .record({
      startLocation: locationArb,
      endGroupDelta: fc.bigInt({ min: 0n, max: 1000000n }),
    })
    .map(({ startLocation, endGroupDelta }) => ({
      type: "AbsoluteRange" as const,
      startLocation,
      endGroupDelta,
    })),
);
```

### PBT 1: `buildPublishParameters` + `buildPublishTrackProperties`

- **Property**: 前節の Arbitrary から生成された任意の `PublishOptions`（`undefined` を含む）を入力とし、以下を検証:
  1. `buildPublishParameters(options)` の戻り値 `Parameter[]` が `encodeParameters` / `decodeParameters` ラウンドトリップで deep equal
  2. `buildPublishTrackProperties(options)` の戻り値 `Property[]` が `encodeProperties` / `decodeProperties` ラウンドトリップで deep equal
- **RFC**: §9.3.2 (Authorization Token), §9.3.8 (EXPIRES), §9.3.9 (LARGEST_OBJECT), §9.3.10 (FORWARD), §11.1-§11.5 (Track Properties)。§11.6 (Immutable Properties) は `PublishOptions` が対応していないため除外
- **注意**: `buildPublishParameters` は AUTHORIZATION TOKEN と LARGEST_OBJECT を扱わない。これは現在の `PublishOptions` がこれらのフィールドを持たないため仕様通りであり、RFC の MAY 要件に反しない。将来 `PublishOptions` に追加された場合は PBT も追従が必要

### PBT 2: `buildSubscribeParameters`

- **Property**: 前節の Arbitrary から生成された任意の `SubscribeOptions`（`undefined` を含む）を入力とし、以下を検証:
  1. `buildSubscribeParameters(options)` の戻り値 `Parameter[]` が `encodeParameters` / `decodeParameters` ラウンドトリップで deep equal
- **RFC**: §9.3.2 (Authorization Token), §9.3.3-§9.3.7, §9.3.10-§9.3.11
- **注意**: `buildSubscribeParameters` は AUTHORIZATION TOKEN を扱わない。これは現在の `SubscribeOptions` がこのフィールドを持たないため仕様通り。`subscribe()` 内の `joiningFetch` 自動 filter 設定は `buildSubscribeParameters` 呼び出しより前に実行されるため、本関数の入力 `options` には影響しない

### PBT 3: `extractLargestLocation`

- **Property**: 前節の `Parameter[]` 任意構築を用いて `LARGEST_OBJECT` (0x09) を含む/含まない `Parameter[]` を生成し、以下を検証:
  1. LARGEST_OBJECT を含む場合、`extractLargestLocation(parameters)` の戻り値が元の Location と一致する
  2. LARGEST_OBJECT を含まない場合、`extractLargestLocation(parameters)` が `undefined` を返す
  3. 複数の LARGEST_OBJECT を含む Parameter[] の場合、最初のものを抽出する
- **Parameter value 構築**: LARGEST_OBJECT の value は `encodeLocation({ group, object })` を使用する（`src/message/parameter.ts` の export。戻り値は VLS エンコードされた Uint8Array）
- **RFC**: §9.3.9

### PBT 4: `extractForwardState`

- **Property**: `FORWARD` (0x10) を含む/含まない `Parameter[]` を構築し、以下を検証:
  1. `forwardValue === 0` → `extractForwardState` は `false`
  2. `forwardValue === 1` → `extractForwardState` は `true`
  3. `forwardValue` が 2-255 → `extractForwardState` は内部で `validateForwardValue` が `ProtocolViolationError` を throw。PBT では `assert.throws` で検証する
  4. FORWARD を含まない → `extractForwardState` はデフォルト値 `true`
- **RFC**: §9.3.10。RFC 原文: "The allowed values are 0 (don't forward) or 1 (forward). If an endpoint receives a value outside this range, it MUST close the session with PROTOCOL_VIOLATION."。この MUST に従い、値 2-255 は forward ではなく ProtocolViolationError である

### PBT 5: `validateFetchOkEndLocation`

- **Property**: 任意の Location ペア `(startLocation, endLocation)` を `fc.record({ group: fc.bigInt({min: 0n}), object: fc.bigInt({min: 0n}) })` で生成 → 以下を検証:
  1. `endLocation.group < startLocation.group` または `(endLocation.group === startLocation.group && endLocation.object < startLocation.object)` の場合のみエラー文字列が返る
  2. 上記以外（Start ＜＝ End）は `undefined` が返る
- **Location 比較定義**: §1.4.2 の "Location A < Location B if: A.Group < B.Group || (A.Group == B.Group && A.Object < B.Object)" に基づく
- **RFC**: §1.4.2, §9.15

### PBT 6: `classifyIncomingStreamType`

- **Property**: `fc.bigInt({ min: 0x00n, max: 0xFFn })` でランダムなストリームタイプ値を生成 → 以下を検証:
  1. `0x05` → `"fetch"`
  2. `0x10-0x1F` または `0x30-0x3F` → `"subgroup"`（RFC §10.4.2 の "0b00X1XXXX" 形式に対応する値域）
  3. 上記以外の全値 → `"unknown"`
- **注意**: 本関数は予約型 (0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F) に対しても `"subgroup"` を返す。これは design decision であり、PBT もこの仕様に従う。呼び出し側の `handleIncomingStream` が予約型チェック (`(streamTypeNum & 0x06) === 0x06`) で PROTOCOL_VIOLATION を送出する責務を持つ形式となっている。現時点では `handleIncomingStream` が `classifyIncomingStreamType` を呼び出しておらず inline の range check を使っているため本関数はデッドコードだが、PBT で仕様を確立し、将来のリファクタリングで `handleIncomingStream` が本関数を呼び出す際の安全性を担保する
- **RFC**: §3.4 (Table 3 の Unidirectional Stream Types), §10.4.2 (Subgroup Header の type 値域), §10.4.4 (Fetch Header の type 値 0x05)

### PBT 7: `calculateObjectIdDelta`

- **Property**: `fc.tuple(fc.bigInt({min: -1n, max: 1000000n}), fc.bigInt({min: 0n, max: 1000000n}))` で `(previousObjectId, currentObjectId)` ペアを生成 → 以下を検証:
  1. `previousObjectId < 0n` の場合、`calculateObjectIdDelta(previousObjectId, currentObjectId) === currentObjectId`
  2. `previousObjectId >= 0n && currentObjectId > previousObjectId` の場合、`previousObjectId + delta + 1n === currentObjectId`
- **`currentObjectId <= previousObjectId` のケース**: 送信側で発生しない前提だが、純粋関数としての挙動を確認する。この場合 `delta = currentObjectId - previousObjectId - 1n`（負の bigint）が返る。後続の `encodeVarint` は負の bigint を受理しないため、送信経路では実質的にエラーとなる。PBT では `fc.pre()` で `currentObjectId > previousObjectId || previousObjectId < 0n` に制限し、負 delta のケースは発生させない
- **RFC**: §10.4.2。原文: "The Object ID Delta + 1 is added to the previous Object ID ... The Object ID is the Object ID Delta if it's the first Object"

## 完了条件

- Phase 1 の全置き換えが完了している（7 箇所）
- `src/session.prop.ts` に PBT 1〜7 が実装され、すべて pass している
- `vp run test` がすべて pass している（全既存テスト + 新規 PBT）
- `vp run build` が pass している（型チェック + ビルド）
- `CHANGES.md` の `## develop` セクションに `### misc` サブセクションを追加し、Phase 1 の置き換え（`[UPDATE]`）と Phase 2 の PBT 追加（`[ADD]`）を記載する

## 優先度

高。session.ts の純粋ロジックが未テストのまま残っており、E2E テストだけではパラメータ構築、値抽出、位置検証、Object ID Delta 計算の網羅的検証ができない。

## 非ゴール

- session.ts のさらなるクラス分割
- パフォーマンス最適化
- PUBLISH / SUBSCRIBE メッセージ全体の envelope（Track Namespace, Track Name, Track Alias を含むペイロード）のラウンドトリップ検証

## 解決方法

Phase 1:

- `publish()` の inline Message Parameters 構築を `buildPublishParameters(options)` 呼び出しに置き換え
- `publish()` の inline Track Properties 構築を `buildPublishTrackProperties(options)` 呼び出しに置き換え
- `subscribe()` の inline Message Parameters 構築を `buildSubscribeParameters(options)` 呼び出しに置き換え
- `readSubscribeResponse()` の inline LARGEST_OBJECT 抽出を `extractLargestLocation(decoded.parameters)` 呼び出しに置き換え
- `readPublishResponse()` の inline FORWARD 抽出を `extractForwardState(decoded.parameters)` 呼び出しに置き換え
- `readFetchResponse()` の inline End Location 検証を `validateFetchOkEndLocation(startLoc, endLoc)` 呼び出しに置き換え
- `sendObjectInternal()` の inline Object ID Delta 計算を `calculateObjectIdDelta(previousObjectId, objectId)` 呼び出しに置き換え

Phase 2:

- `src/session.prop.ts` を新規作成し PBT 1〜7 を実装

変更ファイル:

- `src/session.ts`: 7 箇所の inline ロジックを純粋関数呼び出しに置き換え
- `src/session.prop.ts`: 新規作成、8 関数の PBT を実装
