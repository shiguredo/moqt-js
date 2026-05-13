# 新エラーコード追加

## 概要

複数の新しいエラーコードを追加する。

## 参照

- draft-ietf-moq-transport-17 Section 12
- https://github.com/moq-wg/moq-transport/pull/1434
- https://github.com/moq-wg/moq-transport/pull/1479
- https://github.com/moq-wg/moq-transport/pull/1496
- https://github.com/moq-wg/moq-transport/pull/1445

## 変更内容

- GOING_AWAY を REQUEST_ERROR コードに追加 (#1434)
- EXCESSIVE_LOAD エラーコードを追加 (#1479)
- NAMESPACE_TOO_LARGE エラーコードとストリームリセットを追加 (#1496)
- TOO_FAR_BEHIND ストリームリセットコードを追加 (#1445)
- REQUEST_UPDATE を REQUEST_ERROR の原因リストに追加 (#1466)

## 影響範囲

- `src/error.ts`

## 実装方針

1. draft-17 Section 12 のエラーコード一覧を確認する
2. `src/error.ts` に新しいエラーコードを追加する
3. 各エラーコードの値と用途をコメントで記載する
4. テストを更新する

## 解決方法

`src/error.ts` と `src/message/types.ts` を draft-17 Section 14.5 に準拠させた:

- SessionErrorCode: `TOO_MANY_REQUESTS` を `INVALID_REQUIRED_REQUEST_ID` (0x7) に変更
- RequestErrorCode: `GOING_AWAY` (0x6), `EXCESSIVE_LOAD` (0x9), `NAMESPACE_TOO_LARGE` (0x31) を追加。`DUPLICATE_SUBSCRIPTION` を 0x19 に変更。`UNKNOWN_STATUS_IN_RANGE` を削除
- PublishDoneCode/PublishDoneStatusCode: `MALFORMED_TRACK` を 0x12 に変更。`EXCESSIVE_LOAD` (0x9) を追加
- DataStreamErrorCode: `UNKNOWN_OBJECT_STATUS` (0x4), `TOO_FAR_BEHIND` (0x5), `EXCESSIVE_LOAD` (0x9), `MALFORMED_TRACK` (0x12) を追加
