# supportsDynamicGroups が Immutable Properties 内の DYNAMIC_GROUPS を検出できない

- Priority: High
- Created: 2026-06-30
- Completed: 2026-07-23
- Model: Kimi Code CLI
- Branch: feature/fix-supports-dynamic-groups-immutable-properties
- Polished: 2026-07-23

## 目的

`supportsDynamicGroups()` が `decodeProperties()` の出力（`Property[]`）を正しく解釈できず、Immutable Properties 内に DYNAMIC_GROUPS=1 が含まれている Track を誤って「DYNAMIC_GROUPS 未対応」と判定する。これにより `createMediaSubscriber.requestKeyframe()` が拒否され、キーフレーム要求が送出できなくなる。

## 優先度根拠

- draft-18 §12.7: "When looking for the value of a property, processors MUST search both the mutable properties and the contents of Immutable Properties." — mutable list と Immutable Properties の両方を検索する MUST 要件。
- draft-18 §12.6: "DYNAMIC_GROUPS (Property Type 0x30) is a Track Property. The allowed values are 0 or 1." — DYNAMIC_GROUPS の Property Type と値域の根拠。
- draft-18 §10.2.13: "A subscriber MUST NOT send this parameter in PUBLISH_OK or REQUEST_UPDATE if the Track did not include the DYNAMIC_GROUPS Property with value 1." — `supportsDynamicGroups()` の誤判定がこの MUST NOT 条項に直結し、本来送出可能な NEW_GROUP_REQUEST を抑止する。
- 実運用でキーフレーム要求が誤って拒否される機能障害となる。
- 既存テストがバグを隠蔽する構造になっている（テストコメントは正しいデータ形式を認識しているが、テストコードが矛盾したデータを渡している）。

## 現状

### バグの機序

`src/properties.ts` の `decodeProperties()` は奇数 ID プロパティの `data` に **length プレフィックス以降の body のみ** を格納する（`data.slice(offset + deltaIdLen + lengthLen, ...)`）。

一方、`supportsDynamicGroups()` はその `property.data` を `decodeImmutableProperties()` に渡す。`decodeImmutableProperties()` は **ID + length + body** を想定して先頭から varint ID を読むため、`property.data`（body のみ）の先頭バイトを ID と誤認識する。

具体的に、body `[0x30, 0x01]`（DYNAMIC_GROUPS=1）を渡すと、`0x30` を外側 ID（= 48）、`0x01` を length（= 1）と解釈し、`innerData = subarray(2, 3)` が空になるため `extensions: []` を返す。結果として DYNAMIC_GROUPS が見つからず `false` になる。

### データフロー

`trackProperties` は以下の経路で `supportsDynamicGroups()` に渡される:

1. SUBSCRIBE_OK / FETCH_OK 受信 → `message/subscribe.ts` / `message/fetch.ts` の `decodeProperties()` でデコード
2. `bidi.ts` の `setTrackProperties()` 経由で `Subscriber.trackProperties` / `Fetcher.trackProperties` に格納
3. `createMediaSubscriber.ts` の `requestKeyframe()` が `supportsDynamicGroups(this.videoSubscriber.trackProperties)` を呼び出す

`decodeProperties()` の出力は body-only の `data` を持つため、`supportsDynamicGroups()` は body-only を前提にパースする必要がある。

### 再現

```ts
const encoded = encodeImmutableProperties({
  extensions: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }],
});
// encoded = [0x0B, 0x02, 0x30, 0x01] (ID=0x0B, length=0x02, body=[0x30, 0x01])

const properties = decodeProperties(encoded);
// properties = [{ id: 0x0Bn, data: [0x30, 0x01] }] (body のみ)

supportsDynamicGroups(properties); // => false (本来は true)
```

### テストの構造的問題

`src/properties.test.ts` のテスト "supportsDynamicGroups: Immutable Properties 内 DYNAMIC_GROUPS=1 で true" は、コメントで「body 部のみが Property.data として decode 側に渡される想定」と正しい挙動を記述しているが、テストコードは `encodeImmutableProperties()` の戻り値（ID + length + body の完全形式）をそのまま `Property.data` に代入している。このためテストはパスするが、実際の `decodeProperties()` 出力ではバグが潜んでいる。

### 影響を受けないコード

- `parseProperties()` は IMMUTABLE_PROPERTIES を `decodeImmutableProperties()` 経由ではなくインラインで直接パースしており、このバグの影響を受けない。
- `properties.prop.ts` の PBT ラウンドトリップテストは `encodeImmutableProperties()` の完全出力を `decodeImmutableProperties()` に渡しており、現在のインターフェースで正しく動作している。

## 設計方針

- `decodeImmutableProperties()` の公開インターフェース（ID + length + body を受け取る）は変更しない。PBT ラウンドトリップテスト（`properties.prop.ts`）が現在のインターフェース前提で成立しているため。
- `supportsDynamicGroups()` 内で `property.data`（body のみ）を `decodeProperties()` でパースする。`decodeProperties()` は delta-encoded KVP を body のみからパースする既存の関数であり、再帰 IMMUTABLE_PROPERTIES の検証も含まれている。
- `supportsDynamicGroups()` のシグネチャ（`ReadonlyArray<Property>` を受け取り `boolean` を返す）は変更しない。この関数は `src/index.ts` から公開 API としてエクスポートされている。
- `decodeProperties()` 内の再帰チェック catch ブロックのコメント「不完全な内側 KVP は後段の decodeImmutableProperties で検出される」は、本修正により前提が崩れるため修正する。

## 完了条件

- `supportsDynamicGroups(decodeProperties(encodeImmutableProperties({ extensions: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }] })))` が `true` を返すこと。
- mutable の DYNAMIC_GROUPS=1 / Immutable なしで `true` を返すこと。
- mutable の DYNAMIC_GROUPS=0 / Immutable 内 DYNAMIC_GROUPS=1 で `true` を返すこと。
- mutable / Immutable 両方に DYNAMIC_GROUPS=1 がある場合に `true` を返すこと。
- どちらにも DYNAMIC_GROUPS がない場合に `false` を返すこと。
- Immutable Properties の body が空の場合に `false` を返すこと。
- `src/properties.test.ts` のテストデータ形式が実際の `decodeProperties()` 出力と一致すること（`encodeImmutableProperties()` の戻り値をそのまま `Property.data` に代入しない）。
- `src/properties.ts` の `decodeProperties()` 内再帰チェックコメントが修正されていること。

## 解決方法

1. `src/properties.ts` の `supportsDynamicGroups()` を修正し、`property.data`（body のみ）を `decodeProperties()` でパースする。`decodeImmutableProperties()` は ID + length + body の完全なワイヤー形式を期待するため、body-only の `property.data` には使用できない。
2. `src/properties.test.ts` の `supportsDynamicGroups` 関連テスト（"Immutable Properties 内 DYNAMIC_GROUPS=1 で true"、"Immutable Properties 内 DYNAMIC_GROUPS=0 で false"、"mutable=0 / Immutable=1 混在で true"）を、`decodeProperties(encodeImmutableProperties(...))` の出力を `supportsDynamicGroups()` に渡す形に修正する。テストコメントも実際のデータフローと一致させる。
3. `src/properties.ts` の `decodeProperties()` 内再帰チェック catch ブロックのコメント（「不完全な内側 KVP は後段の decodeImmutableProperties で検出される」）を、修正後の実装と整合する内容に修正する。
4. `properties.prop.ts` の PBT テストは `decodeImmutableProperties()` のインターフェースを変更しないため影響なし。変更不要。

## reopened にする理由

polish-issue による磨き上げが完了したため。仕様引用の検証・設計方針の確定・完了条件の具体化を実施済み。
