# encodeSubgroupHeader が Subgroup ID フィールド必須の type で subgroupId の省略を黙過する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subgroup-id-omitted
- Polished: 2026-09-21

## 目的

`src/dataStream/subgroup.ts` の `encodeSubgroupHeader` は、Subgroup ID フィールドを持つ type (SUBGROUP_ID_MODE 0b10) なのに `subgroupId` が undefined のときフィールドを書かずに後続を連結する。受信側の `decodeSubgroupHeader` はその type で Subgroup ID を無条件に読むため、書かれたバイト数より 1 つ多く消費し、Publisher Priority や Object ID Delta を Subgroup ID として読む壊れたワイヤになる。draft-ietf-moq-transport-21 §11.3.1 は 0b10 のときフィールドが present と定めている。

## 現状

- `src/dataStream/subgroup.ts` の `hasSubgroupIdField` は下位ニブルが 0x4 / 0x5 / 0xc / 0xd のとき true を返す (0x1X / 0x3X / 0x5X / 0x7X の計 16 type)
- `encodeSubgroupHeader` は `hasSubgroupIdField(header.type) && header.subgroupId !== undefined` のときだけ Subgroup ID を書くため、フィールドを持つ type で値が無いと無言で省略する
- 同じ関数は Priority Present の type で `publisherPriority` が undefined のとき `ERR_PUBLISHER_PRIORITY_REQUIRED` で throw しており、扱いが非対称である
- `src/dataStream/datagram.ts` の `encodeObjectDatagram` は Priority Present の type で `publisherPriority` が undefined のとき throw し、`ZERO_OBJECT_ID` の type で `objectId` が 0 でない場合も throw する
- `decodeSubgroupHeader` は 0b10 の type で Subgroup ID を読み、0b00 の type では `0n` を設定し、0b01 の type では undefined のままにする
- 内部の publisher 経路 (`src/session/publish.ts`) は `SubgroupHeaderType.FIRST_OBJ_EXT` (0x13、Subgroup ID = First Object ID) を使い `subgroupId` を渡さないため影響を受けない。不具合を踏むのは公開 API で `encodeSubgroupHeader` を直接呼ぶ場合だけである
- `SubgroupHeader` の JSDoc は type ごとの Subgroup ID の決定方法 (0 / First Object ID / フィールド) と必須フィールドを書いていない

## 設計方針

- 明示的に throw する。「Subgroup ID を持たない type へ切り替える」案は、0b00 は Subgroup ID が 0 に固定され、0b01 は先頭 Object の Object ID が Subgroup ID になるため、同じ Subgroup ID を保つには値か Object ID の採番を変える必要があり取れない
- SUBGROUP_ID_MODE ごとに契約を決める。decode の返り値と往復できる形にする
  - 0b10 (フィールドあり): `subgroupId` は必須。undefined なら throw する
  - 0b00 (Subgroup ID = 0): undefined または `0n` だけを許容し、それ以外の値は throw する (decode は `0n` を返す)
  - 0b01 (Subgroup ID = First Object ID): undefined だけを許容し、値が入っていれば throw する (wire に載せられない)
- エラーは既存の入口検証と同じ汎用 `Error` にする。文言は期待値と実際値を含めて `subgroupId is required when the Subgroup ID field is present: type 0x15, got undefined` の形にし、0b00 / 0b01 の拒否も `got ${値}` を含める。型値は OR 前の `header.type` を使う
- 定数は `src/dataStream/subgroup.ts` 内に置く (前置きの `ERR_SUBGROUP_ID_REQUIRED` と 0b00 / 0b01 用)。型値と実際値を補間するため、定数は前置きに留めてテンプレートで連結する。`src/dataStream/common.ts` は Subgroup と Datagram の共有検証を置く場所であり、`ERR_PUBLISHER_PRIORITY_REQUIRED` がそこにあるのは両経路で共有するためである
- SUBGROUP_ID_MODE の判定は 1 箇所にまとめる (mask 0x06 を右シフトする関数を新設し、`hasSubgroupIdField` と 0b00 / 0b01 の判定をそこから導く)
- 検証は Subgroup ID を書く分岐の直前 (Publisher Priority の検証と同じ位置関係) に置く。既存の type 検証 (予約 SUBGROUP_ID_MODE・形式) より後に置く
- `SubgroupHeader` の JSDoc に 3 モードの要約 (Subgroup ID が 0 / First Object ID / フィールドのどれで決まるか) と必須フィールド (`subgroupId` / `publisherPriority`)、§11.3.1 への参照を書く。`SubgroupHeaderType` 側に既にある型表は再掲しない
- 対象は `src` と `CHANGES.md` とする。`examples` / `devtools` / 内部 publisher 経路は変更しない
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (セクション内は新しい順)

## 完了条件

- Subgroup ID フィールドを持つ 16 type すべてで、`subgroupId` 未指定なら throw し、メッセージに型値 (例: `type 0x15`) が含まれる
- 0b00 の type では `0n` と undefined が通り、`0n` 以外の値は throw する
- 0b01 の type では undefined が通り、値が入っていれば throw する
- 3 つのモードすべてで decode → encode の往復が成立する (0b10 は値が一致、0b00 は `0n`、0b01 は undefined)
- 内部 publisher 経路 (`FIRST_OBJ_EXT`) と PBT (`src/dataStream.prop.ts`) が無変更で通る
- `SubgroupHeader` の JSDoc に 3 モードの要約と必須フィールドが書かれている
- `src/dataStream.subgroup.test.ts` に次のテストが追加される
  - 0b10 の代表 (0x3c と、`publisherPriority` を渡した 0x14) で `subgroupId` 未指定が throw になり、メッセージに型値と `got undefined` が含まれる
  - 0b00 の type で `0n` と undefined が通り、`0n` 以外が `got` 付きで throw になる
  - 0b01 の type で undefined が通り、値ありが `got` 付きで throw になる
  - 3 モードの decode → encode 往復
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §11.3.1 (SUBGROUP_ID_MODE のビット定義と Type Flags の有効値)
- closed 0419 (Publisher Priority の欠落を throw にした同型の先例)

## 解決方法

{未着手}
