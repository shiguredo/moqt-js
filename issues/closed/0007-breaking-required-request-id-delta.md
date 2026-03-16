# SUBSCRIBE/PUBLISH/FETCH に Required Request ID Delta 追加

## 概要

SUBSCRIBE, PUBLISH, FETCH のリクエストメッセージに Required Request ID Delta フィールドを追加する。

## 参照

- draft-ietf-moq-transport-17 Section 5.2

## 変更内容

- draft-17 ではリクエストメッセージに Required Request ID Delta フィールドが追加された
- このフィールドは、リクエストが依存する別のリクエストの ID をデルタエンコードで指定する
- Required Request ID Delta が 0 の場合は依存なしを意味する
- 依存先のリクエストが完了するまで、このリクエストの処理を開始しない

## 影響範囲

- `src/message/subscribe.ts`
- `src/message/publish.ts`
- `src/message/fetch.ts`
- `src/session.ts`

## 実装方針

1. draft-17 Section 5.2 の Required Request ID Delta 仕様を確認する
2. SUBSCRIBE, PUBLISH, FETCH メッセージに Required Request ID Delta フィールドを追加する
3. エンコード・デコード処理を更新する
4. セッション側でリクエスト依存関係の管理を実装する
5. テストを更新する

## 解決方法

`Subscribe`, `Publish`, `Fetch` インターフェースに `requiredRequestIdDelta: bigint` フィールドを追加。エンコード・デコード処理を更新 (requestId の直後に配置)。PBT テストを更新。`session.ts` では現時点で `requiredRequestIdDelta: 0n` (依存なし) を設定。リクエスト依存関係の管理は双方向ストリーム化後に実装する。
