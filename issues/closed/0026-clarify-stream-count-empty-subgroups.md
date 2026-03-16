# Stream Count に空 Subgroup を含む明確化

## 概要

Stream Count が空の Subgroup を含むことを明確化する。

## 参照

- draft-ietf-moq-transport-17 Section 10.1
- https://github.com/moq-wg/moq-transport/pull/1449

## 変更内容

- draft-17 で Stream Count が空の Subgroup (Object を含まない Subgroup) もカウントに含むことが明確化された

## 影響範囲

- `src/dataStream.ts`
- `src/session.ts`

## 実装方針

1. draft-17 Section 10.1 の Stream Count 仕様を確認する
2. 空 Subgroup も Stream Count に含めるように実装を確認・修正する
3. テストを追加する

## 解決方法

Stream Count は PUBLISH_DONE メッセージに含まれ、値の設定はサーバー/リレーの責務。moqt-js はクライアントとして受信した値をそのままデコードするのみ。コード変更不要。
