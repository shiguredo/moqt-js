# sendObjectInternal が encodeObjectFields 切替後にペイロードを送信しなくなり E2E テストが catalog receive timeout になる

Created: 2026-05-13
Completed: 2026-06-02
Model: Opus 4.7
Branch: feature/draft-18

## 概要

コミット `8aaa254` で `sendObjectInternal` を手動のバイトエンコードから `encodeObjectFields` 呼び出しに切り替えた際に、ペイロードデータがストリームに書き込まれなくなった。
すべての Subgroup ストリームオブジェクトでペイロードが欠落し、リレーはペイロード長フィールドを正しくパースするが、
実際のペイロードデータが永遠に届かないため、オブジェクトが TrackCache に挿入されない。
これにより subscriber が catalog を受け取れず `catalog receive timeout` で E2E テストが失敗する。

## 再現手順

1. Publisher を起動し `publishCatalog()` で catalog オブジェクトを送信する
2. Subscriber を起動し catalog track を subscribe する
3. `onCatalog` コールバックが呼ばれず、`catalog receive timeout` が発生する

## 根拠

`encodeObjectFields` (`src/dataStream.ts:313-360`) は Object ID Delta / Properties Length / Payload Length /
Object Status のヘッダ部分のみをエンコードし、`[Object Payload (..)]` は Figure 29 に含まれるが
実際にはエンコードしない設計になっている。ペイロードは呼び出し側で別途書き込む必要がある。

古いコードではペイロードを含む 1 つの `Uint8Array` を構築して `writer.write()` していたが、
`encodeObjectFields` 切替後はヘッダのみの書き込みになり、ペイロードが欠落した。

## 該当コード

`src/session.ts:2333-2341`:

```typescript
const data = encodeObjectFields(
  objectIdDelta,
  BigInt(params.payload.length),
  SubgroupHeaderType.FIRST_OBJ_EXT,
  ObjectStatus.NORMAL,
  params.properties,
);

await streamState.writer.write(data);
// ペイロードが書き込まれていない
```

## 修正方針

`encodeObjectFields` のヘッダ書き込み後に `params.payload` を別途書き込む:

```typescript
const data = encodeObjectFields(
  objectIdDelta,
  BigInt(params.payload.length),
  SubgroupHeaderType.FIRST_OBJ_EXT,
  ObjectStatus.NORMAL,
  params.properties,
);

await streamState.writer.write(data);
if (params.payload.length > 0) {
  await streamState.writer.write(params.payload);
}
```

## 影響範囲

- `src/session.ts`: `sendObjectInternal` にペイロード書き込みを追加する
- ペイロード長 0 のオブジェクト（Object Status のみの特殊オブジェクト）には影響しない

## 完了条件

- `vp run test` 全パス
- `vp run build` 成功
- CI の E2E テスト (`vp run e2e-test`) が成功すること

## 解決方法

本 issue は過去のコミットで既に修正済みである。`src/session.ts` の `sendObjectInternal` 関数 (2797-2800 行) において、`encodeObjectFields` のヘッダ書き込み後に `params.payload` を別途 `writer.write()` することが適切に実装されている。変更不要。
