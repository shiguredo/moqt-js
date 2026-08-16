# encodeSubgroupHeader が Priority Present ありの型で publisherPriority 省略を黙過する

- Priority: Low
- Created: 2026-08-13
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subgroup-header-publisher-priority-required
- Polished: 2026-08-16
- Updated: 2026-08-15

## 目的

draft-ietf-moq-transport-19 §11.4.2 の Subgroup Header で、DEFAULT_PRIORITY bit (0x20) が 0 (Priority フィールドが present) の型には Publisher Priority フィールドが必須である (「When set to 0, the Priority field is present in the Subgroup header.」)。送信側で省略された場合にエラーを throw し、プロトコル違反のヘッダを送信しないようにする (`encodeObjectDatagram` と同じ防御)。

## 現状

- `encodeSubgroupHeader` (`src/dataStream.ts`) は `if (hasPriorityPresent(header.type) && header.publisherPriority !== undefined)` の条件で、Priority present の型で publisherPriority が undefined の場合にフィールドを黙って省略する。
- これはワイヤ形式の違反 (Priority present なのに Priority フィールドが無い) である。デコード側 (`decodeSubgroupHeader`) は Priority バイトを無条件に 1 バイト消費するため、欠落時は後続バイト (Object ID Delta の先頭等) が Priority として誤読されてフィールドずれが生じる (データ次第でデコードエラーになるか誤った値として成立する)。
- 送信経路 (`src/session/publish.ts` は `params.priority ?? 128` で値を補う) では現実に発生しないが、ライブラリの公開関数として不正入力を検出できない。
- `encodeObjectDatagram` (`src/dataStream.ts`) は同条件で `publisherPriority is required when Priority Present bit is set` を throw しており、`encodeSubgroupHeader` のみ非対称。
- 変更対象ファイル: `src/dataStream.ts` (`encodeSubgroupHeader`)、`src/dataStream.subgroup.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- `encodeSubgroupHeader` で Priority present の型に publisherPriority が undefined の場合、`encodeObjectDatagram` と同じ文言の英語エラーメッセージ (`publisherPriority is required when Priority Present bit is set`) で `Error` を throw する。
- Priority present なしの型 (0x30-0x3D / 0x70-0x7D) は従来どおり publisherPriority をワイヤ上にエンコードしない (インターフェイスの `publisherPriority?` は省略可能のまま維持する)。
- 既存テスト `src/dataStream.subgroup.test.ts` の「SubgroupHeader: Priority なしをエンコード」は Priority present の型 (BASE / 0x10) で publisherPriority なしをエンコードしており、本変更で throw するため、テストの修正 (NO_PRIORITY 型への変更または throw 検証への変更) が必要である。

## 完了条件

- Priority Present ありの型で publisherPriority 未指定の `encodeSubgroupHeader` がエラーを throw すること。
- Priority Present なしの型では publisherPriority なしでエンコードできること (既存挙動の維持)。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §11.4.2 (Subgroup Header / Priority Present)
- draft-ietf-moq-transport-19 §11.3.1 (Object Datagram / Priority Present。`encodeObjectDatagram` の先例)

## 解決方法

未着手。
