# OBJECT_DATAGRAM の ZERO_OBJECT_ID 省略時のデフォルト値が 1 ではなく 0 になっている

Created: 2026-05-02
Completed: 2026-05-02
Model: Opus 4.7

## 概要

`decodeObjectDatagram` (`src/dataStream.ts:691`) は Object ID を `let objectId = 0n;` で初期化し、`datagramHasObjectId(typeNum) === false` の場合はそのまま `0n` を返す。仕様では ZERO_OBJECT_ID bit が 1 のとき Object ID は **1** であり、現在の実装は省略タイプ (0x04 / 0x05 / 0x0C / 0x0D / 0x24 / 0x25 / 0x2C / 0x2D) の Object ID を 1 ずれて Subscriber へ渡している。

実装内のコメント (`src/dataStream.ts:556`) 自身が "When set to 1, the Object ID field is omitted and the Object ID is 1." と引用しているにもかかわらず、その値が反映されていない。

## RFC 根拠

draft-ietf-moq-transport-17 Section 10.3.1 (line 4639-4646):

> The ZERO_OBJECT_ID bit (0x04) indicates when the Object ID field is present. When set to 1, the Object ID field is omitted and the Object ID is 1. When set to 0, the Object ID field is present.

(txt 整形上「is」と「1.」が改行で分かれているが、`5127` 行の Subgroup Object フィールド表でも `"Object ID is 1"` と記載されており、値 1 がデフォルトであることは明確。)

## 該当箇所

- `src/dataStream.ts:691` — `let objectId = 0n;` (本来 `let objectId = 1n;` 相当が必要)
- `src/dataStream.ts:553-561` — コメントは仕様通り「Object ID is 1」と書かれている
- `encodeObjectDatagram` (`src/dataStream.ts:607-647` 付近) — ZERO_OBJECT_ID タイプを使う際に `datagram.objectId === 1n` を検証していない

## 期待される動作

- decode 側: `datagramHasObjectId(typeNum) === false` の経路で `objectId = 1n` を採用する。
- encode 側: ZERO_OBJECT_ID bit を持つタイプを選択する場合に `datagram.objectId !== 1n` であれば throw して呼び出し元の不整合を検出する。
- テスト: `dataStream.test.ts` に 0x04 / 0x05 / 0x0C / 0x0D / 0x24 / 0x25 / 0x2C / 0x2D 各タイプの roundtrip テストを追加し、Object ID = 1 になることを確認する。

## 優先度

重大。仕様準拠のピアと組んだ際、ZERO_OBJECT_ID 省略タイプを送信されるとアプリ層へ渡る Object ID が 1 ずれ、Group 内の最終 Object 検出 (END_OF_GROUP) や順序判定が破綻する。

## 解決方法

- decode 側: `decodeObjectDatagram` の `objectId` 初期値を `0n` から `1n` に変更した。
- encode 側: `encodeObjectDatagram` で `datagramHasObjectId(datagram.type)` が `false` の場合に `datagram.objectId !== 1n` であればエラーを throw する検証を追加した。
- テスト: `dataStream.test.ts` の `PAYLOAD_NO_OBJ` タイプのテストデータを `objectId: 0n` から `objectId: 1n` に修正した。
