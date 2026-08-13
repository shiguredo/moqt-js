# encodeSubgroupHeader が Priority Present ありの型で publisherPriority 省略を黙過する

- Priority: Low
- Created: 2026-08-13
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subgroup-header-publisher-priority-required
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §11.4.2 の Subgroup Header で Priority Present bit が立っている型には Publisher Priority フィールドが必須である。送信側で省略された場合にエラーを throw し、プロトコル違反のヘッダを送信しないようにする (`encodeObjectDatagram` と同じ防御)。

## 現状

- `encodeSubgroupHeader` (`src/dataStream.ts`) は `if (hasPriorityPresent(header.type) && header.publisherPriority !== undefined)` の条件で、Priority Present ありの型で publisherPriority が undefined の場合にフィールドを黙って省略する。
- これはワイヤ形式の違反 (Priority Present ありなのに Priority フィールドが無い) であり、ピアはデコードエラーになる。送信経路 (`src/publish.ts` は `params.priority ?? 128` で値を補う) では現実に発生しないが、ライブラリの公開関数として不正入力を検出できない。
- `encodeObjectDatagram` (`src/dataStream.ts`) は同条件で `publisherPriority is required when Priority Present bit is set` を throw しており、`encodeSubgroupHeader` のみ非対称。
- 変更対象ファイル: `src/dataStream.ts` (`encodeSubgroupHeader`)、`src/dataStream.subgroup.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- `encodeSubgroupHeader` で Priority Present ありの型に publisherPriority が undefined の場合、`encodeObjectDatagram` と同じ形式の英語エラーメッセージで throw する。
- Priority Present なしの型 (0x30-0x3D) は従来どおり publisherPriority を保持しない。

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
