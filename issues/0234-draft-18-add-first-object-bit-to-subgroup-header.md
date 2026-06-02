# Subgroup Header に FIRST_OBJECT bit (0x40) を追加し、対応する 24 種類の Type 定数を実装する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/add-subgroup-header-first-object-bit
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-18 §11.4.2 で定義されている FIRST_OBJECT bit (0x40) を `SubgroupHeaderType` に追加する。現在は FIRST_OBJECT bit がセットされた 24 種類 (0x50-0x7D) の Type 定数が存在せず、受信時に認識できない。

## 優先度根拠

§11.4.2 で "When the Original Publisher opens a new subgroup, it MUST set the FIRST_OBJECT bit" と規定されており、draft-18 で必須化されたフィールド。未実装の場合、新しいサブグループの先頭オブジェクトを認識できず、データの整合性に影響するため High。

## 一次資料の引用

draft-ietf-moq-transport-18 §11.4.2 (Subgroup Header):

> The Type field in the SUBGROUP_HEADER takes the following form:
> ```
>  0 1 2 3 4 5 6 7
> +-+-+-+-+-+-+-+-+
> |0|X|X|1|X|X|X|X|
> +-+-+-+-+-+-+-+-+
> ```
> Bit 4 MUST be set to 1.
> Bit 7 MUST be set to 0. FIRST_OBJECT: When set to 1, the first object in the subgroup stream is the first object ever published in that subgroup.

draft-ietf-moq-transport-18 §2.2:

> When the Original Publisher opens a new subgroup, it MUST set the FIRST_OBJECT bit (Section 11.4.2) to indicate that the first object in the subgroup stream is the first object ever published in that subgroup.

## 現状

`src/dataStream.ts:70-126` の `SubgroupHeaderType` は 0x10-0x1D と 0x30-0x3D の 24 種類のみ。FIRST_OBJECT bit (0x40) がセットされた 24 種類 (0x50-0x5D, 0x70-0x7D) が欠落。

`src/dataStream.ts:37-68` のコメントのタイプマトリクス表も 0x30-0x3D までしか列挙していない。

`SubgroupHeader` インターフェイスに `firstObject` フィールドがない。

## 設計方針

### 1. SubgroupHeaderType への追加

0x40 の OR マスクで既存 Type の FIRST_OBJECT 版を 24 種類追加する:

```typescript
BASE_FIRST: 0x50,
BASE_EXT_FIRST: 0x51,
// ... 以下 24 種類を追加
```

### 2. コメントの更新

`src/dataStream.ts:37-68` のタイプマトリクス表に 0x50-0x5D と 0x70-0x7D を追記する。

### 3. SubgroupHeader インターフェイスへの `firstObject` 追加

```typescript
export interface SubgroupHeader {
  type: number;
  trackAlias: bigint;
  groupId: bigint;
  subgroupId: bigint;
  publisherPriority: number;
  firstObject?: boolean;  // Type の bit 6 (0x40) から抽出
  properties?: Uint8Array;
}
```

### 4. encodeSubgroupHeader の対応

`encodeSubgroupHeader` に `firstObject` オプションを追加し、0x40 ビットをセットできるようにする。

### 5. decodeSubgroupHeader の対応

`decodeSubgroupHeader` で Type の bit 6 (0x40) をチェックし、`firstObject` フィールドを設定する。

### 6. bit 7 のバリデーション修正

`src/dataStream.ts:244` の `(typeNum & 0x10) === 0` を `(typeNum & 0x10) === 0 || (typeNum & 0x80) !== 0` に変更し、bit 7 がセットされた不正値 (0x90 等) を検出する。

## 影響範囲

- `src/dataStream.ts`: `SubgroupHeaderType` に 24 種類の定数追加、コメント更新、`SubgroupHeader` インターフェイスに `firstObject` 追加、`encodeSubgroupHeader` / `decodeSubgroupHeader` の対応
- `src/dataStream.test.ts`: FIRST_OBJECT bit のエンコード/デコードテスト追加
- `src/session.ts`: Subgroup Header のデコード結果を利用する箇所（`firstObject` の伝搬が必要か確認）

## 完了条件

- `SubgroupHeaderType` に 0x50-0x5D, 0x70-0x7D の 24 種類が定義されている
- `SubgroupHeader` インターフェイスに `firstObject` フィールドがある
- `encodeSubgroupHeader` が FIRST_OBJECT bit を設定できる
- `decodeSubgroupHeader` が FIRST_OBJECT bit を正しくデコードする
- コメントのタイプマトリクスが 0x50-0x7D まで網羅されている
- `(typeNum & 0x80) !== 0` のバリデーションが追加されている
- `vp run test` 全パス
- `vp run build` 成功
