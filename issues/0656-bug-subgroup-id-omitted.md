# Subgroup ID を持つ Subgroup Header type でフィールドを無言で省略する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subgroup-id-omitted
- Polished: {YYYY-MM-DD}

## 目的

`src/dataStream/subgroup.ts` の `encodeSubgroupHeader` は、Subgroup ID フィールドを持つ type なのに `subgroupId` が undefined のときフィールドを書かずに後続を連結する。受信側は Subgroup ID を消費するため、フィールドが 1 つずつずれた壊れたワイヤを生成する。

## 現状

- `src/dataStream/subgroup.ts` の `hasSubgroupIdField` は type の下位ニブルが 0x4 / 0x5 / 0xc / 0xd のとき true を返す (0x14 / 0x15 / 0x1C / 0x1D / 0x34 / 0x35 系)
- `encodeSubgroupHeader` は `hasSubgroupIdField(header.type) && header.subgroupId !== undefined` のときだけ `subgroupId` を書くため、Subgroup ID フィールドを持つ type で値が無いと無言で省略する
- 同じ関数は Priority Present の type で `publisherPriority` が undefined のとき `ERR_PUBLISHER_PRIORITY_REQUIRED` で throw しており、扱いが非対称である
- `src/dataStream/datagram.ts` の `encodeObjectDatagram` は Priority Present の type で `publisherPriority` が undefined のとき throw し、`ZERO_OBJECT_ID` の type で `objectId` が 0 でない場合も throw する
- ライブラリ内部の publisher 経路 (`src/session/publish.ts`) は `SubgroupHeaderType.FIRST_OBJ_EXT` を使い、Subgroup ID フィールドを持たない。この経路は公開 API の利用者だけが踏む
- `SubgroupHeader` の JSDoc は `type` ごとにどのフィールドが必須かを書いていない

## 設計方針

- 明示的に throw するか、Subgroup ID を持たない type へ切り替えるかを決める。type がフィールドの存在を決める以上、`publisherPriority` と同じく throw が整合する
- throw する場合はエラー文言と、`ERR_PUBLISHER_PRIORITY_REQUIRED` に倣った定数の置き場所を決める
- Subgroup ID を持たない type に `subgroupId` が渡された場合の扱いも決める
- 公開 API の契約 (どの type でどのフィールドが必須か) を `SubgroupHeader` の JSDoc に明記する
- `src/dataStream.subgroup.test.ts` に type ごとの必須フィールドのテストを追加する

## 完了条件

- 壊れたワイヤを生成する経路が無くなる
- type ごとに必須なフィールドがテストで固定される
- 公開 API の契約が JSDoc に書かれている
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
