# Subgroup Header の FIRST_OBJECT ビットを設定する

- Priority: High
- Created: 2026-06-17
- Completed: 2026-06-20
- Model: Opus 4.8
- Branch: feature/fix-subgroup-header-first-object-bit
- Polished: 2026-06-20

## 目的

`sendObjectInternal` が新しい subgroup の最初のオブジェクトを送信する際、Subgroup Header に `FIRST_OBJECT` ビット (`0x40`) を設定するように修正する。`encodeSubgroupHeader` は既に `firstObject` パラメータを受け付けるが、呼び出し元が未設定のため常にビットが立たない。

## 優先度根拠

draft-ietf-moq-transport-18 §11.4.2 では、新しい subgroup の最初のオブジェクトに対して `FIRST_OBJECT` ビットを設定することが MUST とされている。設定しないと、受信側は subgroup 内の最初のオブジェクトを正しく識別できず、依存関係の解決やデコーダーの初期化が失敗する。相互運用に直結するため High。

## 現状

`src/session.ts` の `sendObjectInternal` L2959-2964 において:

```typescript
const header = encodeSubgroupHeader({
  type: SubgroupHeaderType.FIRST_OBJ_EXT,
  trackAlias,
  groupId,
  publisherPriority: params.priority ?? 128,
});
```

`encodeSubgroupHeader`（`src/dataStream.ts` L272-273）は既に `firstObject` プロパティに対応しており、`true` の場合に `header.type | 0x40` で FIRST_OBJECT ビットを OR する。しかし呼び出し元が `firstObject` を設定していないため、常にビットが立たない。

1 Group = 1 Subgroup = 1 Stream モデルでは、新しい単方向ストリームを開くときは常に新しい subgroup の最初のオブジェクトである。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§11.4.2 (Subgroup Header)**: Original Publisher は新しい subgroup を開く際、最初のオブジェクトの header type に `FIRST_OBJECT` ビット (`0x40`) を設定しなければならない (MUST)
- **§2.2 (Object)**: `FIRST_OBJECT` ビットが立つオブジェクトは、その subgroup 内で他のオブジェクトのデコードに必要な初期情報を含む

## 設計方針

`sendObjectInternal` で新しいストリームを開く分岐（`!streamState || streamState.groupId !== groupId`）において、`encodeSubgroupHeader` 呼び出しに `firstObject: true` を追加する。同一ストリーム上の後続オブジェクト（既存 `streamState` への書き込み）では設定しない。

```typescript
const header = encodeSubgroupHeader({
  type: SubgroupHeaderType.FIRST_OBJ_EXT,
  trackAlias,
  groupId,
  publisherPriority: params.priority ?? 128,
  firstObject: true, // ← 追加
});
```

`firstObject` プロパティは `SubgroupHeader` インターフェース（`dataStream.ts` L227）に既存であり、型定義の変更は不要。エンコード側も `dataStream.ts` L272-273 で既に対応済み。

## 変更対象ファイル

- `src/session.ts`: `sendObjectInternal` の `encodeSubgroupHeader` 呼び出しに `firstObject: true` を追加する（1 行修正）
- `src/dataStream.subgroup.test.ts`: `firstObject: true` のエンコード・デコードテストを追加する
- `CHANGES.md` に `[FIX]` エントリを追記する

## テスト方針

- 既存の全テストが PASS することを必須とする
- `src/dataStream.subgroup.test.ts` に `firstObject: true` を設定したテストケースを追加する:
  - `FIRST_OBJ_EXT` (0x13) + `firstObject: true` → エンコード結果の type バイトが `0x53` (= `0x13 | 0x40`) であることの検証
  - 上記のエンコード後バイト列がデコードされて `firstObject: true` として復元されることのラウンドトリップ検証
  - ラウンドトリップ検証では、既存の `assert.equal(decoded.type, tc.header.type)` アサーションが `firstObject: true` 時に失敗するため、`(decoded.type & 0x3f) === tc.header.type` に調整する
- `sendObjectInternal` の変更は `session.prop.ts` の PBT では直接検証されない（純粋関数のみが対象のため）ことに注意。結合テストまたは手動テストでカバーする

## 完了条件

- 新しい subgroup の最初のオブジェクトに `FIRST_OBJECT` ビット (`0x40`) が設定される
- 2 番目以降のオブジェクトには `FIRST_OBJECT` ビットが立たない
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリが追記される

## 解決方法

`src/session.ts` の `sendObjectInternal` において、新しいストリームを開く分岐での `encodeSubgroupHeader` 呼び出しに `firstObject: true` を追加した。
`src/dataStream.subgroup.test.ts` に `firstObject: true` のエンコード・デコードテスト 2 件を追加した。

変更ファイル:

- `src/session.ts`: `encodeSubgroupHeader` 呼び出しに `firstObject: true` 追加
- `src/dataStream.subgroup.test.ts`: `firstObject` ビットのエンコード・デコードテスト追加
- `CHANGES.md`: `[FIX]` エントリ追記
