# Fetch Object の DATAGRAM ビット (0x40) 対応を実装する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/add-fetch-datagram-flag-handling
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 で定義されている Fetch Object Fields の DATAGRAM フラグ (0x40) が未対応であるため、実装する。

- Section 11.2.1 (Object Header):

  > "Subgroup ID: The identifier of the Object's Subgroup within the Group.
  > This field is omitted if the Object Forwarding Preference is Datagram."

- Section 11.4.4.1 Table 9:
  > "When encoding an Object with a Forwarding Preference of 'Datagram',
  > the object has no Subgroup ID. The publisher MUST SET bit 0x40 to '1'.
  > When 0x40 is set, it SHOULD set the two least significant bits to
  > zero and the subscriber MUST ignore the bits."

現在の `decodeFetchObjectFields` は DATAGRAM ビット (0x40) を全くチェックしておらず、下位 2 ビットの Subgroup ID encoding を無視せずに処理してしまう。これにより以下の問題が発生する:

1. **Subgroup ID フィールドの誤読**: DATAGRAM + SUBGROUP_PRESENT (0x43) の組み合わせで wire format 上の Subgroup ID vi64 フィールドを意図せず読み取り、後続の Object ID を誤った位置からデコードする
2. **FetchObjectContext の Subgroup ID 伝搬破綻**: Datagram オブジェクトの後続で SUBGROUP_SAME (0x01) が指定された場合、context の subgroupId が Datagram 由来の 0n で上書きされ、本来の Subgroup ID と不一致になる

## 優先度根拠

Subscriber 側の MUST 要件 (Section 11.4.4.1: "subscriber MUST ignore the bits") の欠落。Datagram forwarding preference の Object を FETCH で取得するケースで Subgroup ID が誤計算され、デコード破綻に直結する可能性がある。ただし Fetch 対象は Subgroup forwarding preference が主と想定されるため Medium とする。

## 現状

### decode 側

`src/dataStream.ts` `decodeFetchObjectFields` (line 1278-1303):

```ts
// DATAGRAM ビットのチェックなしに下位 2 ビットを評価している
const subgroupEncoding = flags & FetchSerializationFlags.SUBGROUP_MASK;
switch (subgroupEncoding) {
  case FetchSerializationFlags.SUBGROUP_ZERO: // subgroupId = 0n
  case FetchSerializationFlags.SUBGROUP_SAME: // context.subgroupId
  case FetchSerializationFlags.SUBGROUP_PLUS_ONE: // context.subgroupId + 1n
  case FetchSerializationFlags.SUBGROUP_PRESENT: // decodeVarint で Subgroup ID 読み取り
}
```

DATAGRAM ビット (0x40) が立っている場合:

- 下位 2 ビットが `SUBGROUP_ZERO (0x00)` なら、意図しない `subgroupId = 0n` になる（たまたま動作するが不正）
- 下位 2 ビットが `SUBGROUP_PRESENT (0x03)` なら、wire 上の Subgroup ID vi64 を読み取って `offset` がずれる
- 下位 2 ビットが `SUBGROUP_SAME (0x01)` または `SUBGROUP_PLUS_ONE (0x02)` で先頭オブジェクトの場合、ProtocolViolationError が誤って throw される

コンテキスト更新 (line 1374-1379) では subgroupId がそのまま `newContext` に設定されるため、後続の非 Datagram オブジェクトが SUBGROUP_SAME を使う場合に誤った Subgroup ID が参照される。

### encode 側

`encodeFetchObjectFields` (line 1036) および `createFetchObjectFlags` (line 1416) には DATAGRAM ビットの概念がなく、DATAGRAM 時の下位 2 ビット強制ゼロクリアが行われていない。`createFirstFetchObjectFlags` (line 1399) は常に SUBGROUP_PRESENT (0x03) を設定しており、Datagram 先頭オブジェクト用の flags 生成が不可能。

エンコード側の修正は PBT ラウンドトリップテストで必要な範囲に限定する（moqt-js はクライアント専用のため encode はランタイムで使用しない）。

## 設計方針

### decodeFetchObjectFields (核心)

1. Subgroup ID encoding switch の前に DATAGRAM ビット (`flags & 0x40`) をチェックする
2. DATAGRAM 時は wire format 上の Subgroup ID フィールドを適切に消費する:
   - `SUBGROUP_PRESENT (0x03)`: wire 上の Subgroup ID vi64 を `decodeVarint` で**読み飛ばす**（offset は進める）
   - それ以外: フィールド消費不要
3. `subgroupId` は `0n` に設定する（`bigint` 型の制約上 `undefined` は不可）
4. コンテキスト (`newContext`) の subgroupId には、Datagram オブジェクト以前の最後の**実際の** Subgroup ID（非 Datagram オブジェクトの subgroupId）を伝搬させる。これにより後続オブジェクトの SUBGROUP_SAME が正しく動作する

### encodeFetchObjectFields / createFetchObjectFlags

PBT ラウンドトリップ用。flags に DATAGRAM ビット (0x40) が含まれる場合、下位 2 ビットの強制ゼロクリアに加え、SUBGROUP_PRESENT 時でも Subgroup ID フィールドをエンコードしない。

### createFirstFetchObjectFlags

Datagram 先頭オブジェクト用の flags を生成できるよう、`hasExtensions` に加えて Datagram 用のパラメータを追加する。Datagram 時は `DATAGRAM | SUBGROUP_ZERO (0x40)` を設定する。

### 他 issue との関係

- 0241: 同一関数 `decodeFetchObjectFields` を修正するため、0241 を先に対応することを推奨
- 0243: 同一関数に overflow チェックを追加する

## 完了条件

- `decodeFetchObjectFields` が DATAGRAM フラグ (0x40) セット時に下位 2 ビットを無視し、`subgroupId = 0n` を返すこと
- DATAGRAM + SUBGROUP_PRESENT (0x43) の組み合わせで wire 上の Subgroup ID vi64 フィールドを正しく読み飛ばすこと
- Datagram オブジェクト後続の非 Datagram オブジェクトで正しい Subgroup ID が参照されること
- `createFirstFetchObjectFlags` が Datagram 先頭オブジェクト用の flags を生成できること

### 必要なテストケース

1. DATAGRAM (0x40) 単独 → subgroupId = 0n で正しくデコード
2. DATAGRAM + SUBGROUP_ZERO (0x40) → 同上
3. DATAGRAM + SUBGROUP_PRESENT (0x43) → Subgroup ID vi64 を読み飛ばし、subgroupId = 0n
4. DATAGRAM + SUBGROUP_SAME (0x41) / SUBGROUP_PLUS_ONE (0x42) → 先頭オブジェクトでもエラーにならず subgroupId = 0n
5. 非 Datagram → Datagram → 非 Datagram の混在シーケンスで Subgroup ID が正しく伝搬
6. `createFirstFetchObjectFlags` が Datagram 引数を受け取り正しい flags を返す
7. encode → decode roundtrip (DATAGRAM 付き)
8. `src/dataStream.test.ts` の既存 DATAGRAM テスト (line 885) の見直し
