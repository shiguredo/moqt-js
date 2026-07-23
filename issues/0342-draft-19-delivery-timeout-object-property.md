# Delivery Timeout を Object Property としても扱えるようにする (draft-19 追従)

- Priority: Low
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-delivery-timeout-object-property
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 で `OBJECT_DELIVERY_TIMEOUT` (0x02) / `SUBGROUP_DELIVERY_TIMEOUT` (0x06) が Track Property に加え Object Property にもなった (Appendix A.1 `#1476`)。subgroup 先頭オブジェクトの Object Property で Track 値を上書きできるようにし、受信側アプリケーションがその上書き値を読めるようにする。

セマンティクスの本体は Section 8。Property 定義は Section 12.1 / 12.2。IANA Scope は Section 15.8 で `Track, Object`。

**本 issue の範囲外**: delivery timeout のタイマー実行・ストリーム reset / datagram drop (Section 8 の MUST 動作)。moqt-js は現状どおり値の保持・中継・公開までとし、タイマー実装は扱わない。

## 優先度根拠

additive な拡張であり、未対応でも制御プレーンの相互運用は壊れない。`SendObjectParams.properties` / `MoqtObject.properties` は既に `Uint8Array` のため、アプリケーションが自前で `encodeProperties` / `decodeProperties` すれば wire 上の送受信自体は可能。欠けるのは (1) Object スコープとしての一次資料整合 (定数・コメント)、(2) subgroup 先頭での上書きをライブラリが型付きで扱いやすい形で公開すること。実害は限定的なので Low。

## 現状

- `src/properties.ts`: `TrackPropertyId` に `OBJECT_DELIVERY_TIMEOUT: 0x02n` / `SUBGROUP_DELIVERY_TIMEOUT: 0x06n` がある。Object 専用 ID は `MOQTPropertyId` の `PRIOR_GROUP_ID_GAP` / `PRIOR_OBJECT_ID_GAP` のみ。0x02 / 0x06 が Object Property でも有効であることは定数・コメントどちらにも表れていない
- `src/session/params.ts`: 送信は Track Property (`buildPublishTrackProperties`) / Message Parameter (`buildSubscribeParameters`) のみ。Object Property 経路はない
- `src/session.ts`: `PublishOptions` / `SubscribeOptions` の `deliveryTimeout` / `subgroupDeliveryTimeout` は Track / Message Parameter 用
- `src/publisher.ts`: `SendObjectParams.properties?: Uint8Array` (opaque)。型付き delivery timeout フィールドはない
- `src/dataStream.ts`: `MoqtObject.properties?: Uint8Array` (opaque)。受信パス (`src/session/stream.ts` の `processSubgroupObjects`) も個別 Property ID を解釈しない
- subgroup 先頭の判定材料は既にある: 送信は `previousObjectId < 0n` (`sendObjectInternal`)、受信は `processSubgroupObjects` 内の `currentPreviousObjectId < 0n`。`SubgroupHeader.firstObject` (FIRST_OBJECT bit) は「その subgroup で初めて publish されたオブジェクト」を示す別フラグであり、本 issue の「subgroup 先頭オブジェクト」判定には使わない

## 設計方針

### 一次資料 (実装が従う規則)

draft-ietf-moq-transport-19 Section 8:

> Either timeout value can also be set as an Object Property on the first
> object in a subgroup, overriding the Track-level value for that
> subgroup. If either timeout is set as an Object Property on any
> object other than the first in a subgroup, it is ignored. For each
> type of timeout, the publisher's value is the Object Property when
> present on the first object of the subgroup, and the Track Property
> otherwise.

draft-ietf-moq-transport-19 Section 12.1:

> SUBGROUP_DELIVERY_TIMEOUT (Property Type 0x06) is a Track and Object
> Property. It is a varint. Its semantics are defined in Section 8.
> As an Object Property on the first object in a subgroup, it overrides
> the Track-level value for that subgroup; it is ignored on any other
> object in the subgroup.

draft-ietf-moq-transport-19 Section 12.2:

> OBJECT_DELIVERY_TIMEOUT (Property Type 0x02) is a Track and Object
> Property. It is a varint. Its semantics are defined in Section 8.
> As an Object Property on the first object in a subgroup, it overrides
> the Track-level value for that subgroup; it is ignored on any other
> object in the subgroup.

Section 15.8 Properties テーブルの Scope はいずれも `Track, Object`。Property Type (`0x02` / `0x06`) は不変。

### 実装方針（固定）

1. **定数・コメント**: `src/properties.ts` で 0x02 / 0x06 が Track かつ Object Property であることを draft-19 Section 12.1 / 12.2 / 15.8 に合わせて明記する。全 Property 向けの汎用 Scope 検証フレームワークは導入しない。既存の `encodeProperties` / `decodeProperties` は偶数 ID の varint として既に 0x02 / 0x06 を扱える
2. **publisher (書き込み)**: `SendObjectParams` に `deliveryTimeout?: bigint` / `subgroupDeliveryTimeout?: bigint` を追加する
   - subgroup 先頭 (`previousObjectId < 0n`) のときだけ、これらを Object Properties に載せる
   - 既存 `properties?: Uint8Array` がある場合: **Object 向けの寛容な KVP 走査**（または同等ヘルパ）で既存 ID を読み、型付き値で同 ID を上書きして再 encode。Track 向け `decodeProperties`（Mandatory Track Property `0x4000`–`0x7FFF` 検証や `validateTrackPropertyValue`）は使わない（Object バイト列に載せると誤って `MalformedTrackError` になり得る）
   - `properties` 生バイトと型付きの**同一 ID 衝突**は型付きを優先し、ドキュメントに明記する
   - 先頭以外で型付きフィールドが指定されたら **API が throw**
   - `undefined` は未指定。`0n` は仕様どおり「タイムアウトなし」の有効値として送る（`!== undefined` で判定）
   - 負の値は Track 側と同様 `validateNonNegative` 相当で拒否
3. **subscriber (読み取り)**: `MoqtObject` に `objectDeliveryTimeout?: bigint` / `subgroupDeliveryTimeout?: bigint` を追加する（送信側の `deliveryTimeout` と名前を分ける: 受信は Object Property 由来であることを示す）
   - `processSubgroupObjects` で先頭 (`currentPreviousObjectId < 0n`) のときだけ、上記ヘルパで 0x02 / 0x06 を抽出して埋める
   - 先頭以外に同 ID が付いていても **フィールドは埋めない**（ignore。PROTOCOL_VIOLATION にしない）
   - 抽出不能・不完全データ: 型付きフィールドは未設定のまま、opaque `properties` は従来どおり渡し、オブジェクト配信は継続する
   - **Fetch / Datagram 経路では型付きフィールドを埋めない**（本機能は subgroup ストリームの先頭オブジェクトのみ）
4. **Datagram**: Section 8 の Object Property 上書きは「first object in a subgroup」に限定。`sendDatagram` / `handleIncomingDatagram` は対象外（型付きフィールドを Datagram API に足さない）
5. **タイマー**: Section 8 の retain / reset / drop は実装しない
6. **仕様参照コメント**: 本 issue で触るファイルの draft-18 参照だけ draft-19 に直す。一括更新は `#0343`
7. **CHANGES.md**: 公開 API 追加は `[ADD]`。合成規則・非先頭 throw・受信 ignore を箇条書き

## 完了条件

- subgroup 先頭オブジェクトに型付き API で `OBJECT_DELIVERY_TIMEOUT` / `SUBGROUP_DELIVERY_TIMEOUT` を付けて送信し、受信側 `MoqtObject.objectDeliveryTimeout` / `subgroupDeliveryTimeout` で読めるテストがあること
- 先頭以外のオブジェクトに同 Property がワイヤ上付いていても、受信側の型付きフィールドが埋まらないこと（ignore）
- 先頭以外で型付き送信フィールドを指定すると API が throw すること
- datagram / fetch 経路で型付き delivery timeout フィールドを埋めていないこと
- 不完全な properties でもオブジェクト配信が継続し、型付きフィールドだけ未設定になること
- タイマー実行・ストリーム reset を追加していないこと
- `CHANGES.md` の `## develop` に `[ADD]` があること
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. `src/properties.ts`: コメントを draft-19 Section 12.1 / 12.2 / 15.8 / 8 に更新。Object 向けに 0x02 / 0x06 を寛容抽出するヘルパ（例: `readDeliveryTimeoutObjectProperties`）と、既存 properties バイトへ型付き値を合成するヘルパを追加。**Track 向け `decodeProperties` は使わない**
2. `src/publisher.ts`: `SendObjectParams` に `deliveryTimeout?` / `subgroupDeliveryTimeout?` を追加
3. `src/session.ts` の `sendObjectInternal`: 先頭判定で合成ヘルパを呼び encode。非先頭で型付き指定 → throw
4. `src/dataStream.ts`: `MoqtObject` に `objectDeliveryTimeout?` / `subgroupDeliveryTimeout?` を追加
5. `src/session/stream.ts` の `processSubgroupObjects`: 先頭時のみ抽出ヘルパで埋める。非先頭・Fetch・Datagram は埋めない
6. テスト: 先頭 round-trip、非先頭 ignore、非先頭送信 throw、opaque 同居、不完全 properties でも配信継続、datagram/fetch 非対象、タイマー非実装の回帰
7. `CHANGES.md`: `[ADD]`
8. `vp check` / `tsc --noEmit` / `vp test run`
