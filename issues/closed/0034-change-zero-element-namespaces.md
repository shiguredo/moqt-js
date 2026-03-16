# ゼロ要素ネームスペースを許可

## 概要

ゼロ要素 (空) のネームスペースを許可する。

## 参照

- draft-ietf-moq-transport-17 Section 2.3
- https://github.com/moq-wg/moq-transport/pull/1472

## 変更内容

- draft-16 ではネームスペースは少なくとも 1 つの要素を持つ必要があった
- draft-17 ではゼロ要素のネームスペース (空のネームスペース) が許可された

## 影響範囲

- `src/message/namespace.ts`
- `src/message/subscribe.ts`
- `src/message/publish.ts`

## 実装方針

1. draft-17 Section 2.3 のネームスペース仕様を確認する
2. ネームスペースのバリデーションからゼロ要素チェックを削除する
3. 空のネームスペースを正しくエンコード・デコードできることを確認する
4. テストを追加する

## 解決方法

エンコード/デコードロジック (`encodeTrackNamespace`/`decodeTrackNamespace`/`createTrackNamespace`) は既にゼロ要素をサポートしていた。PBT テストの `namespaceStringsArb` の配列最小長を `minLength: 1` から `minLength: 0` に変更し、ゼロ要素ネームスペースのラウンドトリップテストを追加した。

変更ファイル:

- `src/message/publish.prop.ts`
- `src/message/subscribe.prop.ts`
- `src/message/trackstatus.prop.ts`
- `src/message/namespace.prop.ts`
- `src/message/fetch.prop.ts`
