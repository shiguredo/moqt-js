# Fetch Object に Object Status を含めている

Created: 2026-03-29
Model: Opus 4.6

## 概要

Fetch ストリーム上のオブジェクトのエンコード/デコードで Object Status フィールドを含めているが、draft-17 では Fetch 経由のオブジェクトには Object Status は存在しない。

## RFC 根拠

draft-ietf-moq-transport-17 Section 10.2.1.1 Object Status:

> The Object Status is a field that is only present in objects that are delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH. It allows the publisher to explicitly communicate that a specific range of objects does not exist.

Fetch Object Fields (Figure 27) にも Object Status フィールドは含まれていない。

## 該当箇所

- `src/dataStream.ts` 行 1024-1026: エンコード時に Payload Length が 0 の場合に Status を書き込んでいる
- `src/dataStream.ts` 行 1207-1212: デコード時に Payload Length が 0 の場合に Status を読み取っている

## 修正方針

Fetch Object のエンコード/デコードから Object Status フィールドの処理を削除する。

## 解決方法

- `FetchObjectFields` インターフェースと `DecodedFetchObject` インターフェースから `status` フィールドを削除した
- `encodeFetchObjectFields()` から Object Status のエンコード処理を削除した
- `decodeFetchObjectFields()` から Object Status のデコード処理を削除した
- Fetch 経由で受信したオブジェクトを `MoqtObject` に変換する際は `ObjectStatus.NORMAL` を設定するようにした
