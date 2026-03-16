# FETCH の End of Range 後の prior Object セマンティクス

## 概要

FETCH リクエストにおける End of Range 指示子の後の prior Object のセマンティクスを明確化する。

## 参照

- draft-ietf-moq-transport-17 Section 6.3
- https://github.com/moq-wg/moq-transport/pull/1513

## 変更内容

- draft-17 で FETCH の End of Range 指示子の後に prior Object をどう扱うかのセマンティクスが明確化された
- End of Range に達した後のデータ配信の挙動が定義された

## 影響範囲

- `src/fetcher.ts`
- `src/session.ts`
- `src/dataStream.ts`

## 実装方針

1. draft-17 Section 6.3 の End of Range セマンティクスを確認する
2. FETCH の End of Range 後の Object 処理を仕様に沿って実装する
3. テストを追加する

## 解決方法

`FetchSerializationFlags` に `END_OF_NON_EXISTENT_RANGE` (0x8C) と `END_OF_UNKNOWN_RANGE` (0x10C) を追加。`DecodedFetchObject` に `endOfRange` フィールドを追加。`decodeFetchObjectFields` で End of Range indicator を検出し、Group ID と Object ID のみをデコードするロジックを実装。Serialization Flags を varint としてデコードするように変更。`encodeFetchObjectFields` も End of Range 対応に更新。

変更ファイル:

- `src/dataStream.ts`: FetchSerializationFlags, DecodedFetchObject, encode/decode
- `src/dataStream.test.ts`: テスト更新
- `src/index.ts`: EndOfRangeType エクスポート追加
