# Setup Parameters を Setup Options にリネーム

## 概要

Setup Parameters という用語を Setup Options にリネームする。

## 参照

- draft-ietf-moq-transport-17 Section 9.4.1
- https://github.com/moq-wg/moq-transport/pull/1461

## 変更内容

- draft-16 では Setup Parameters と呼ばれていた機能が、draft-17 では Setup Options にリネームされた
- コード内の Setup Parameters への参照をすべて Setup Options に変更する

## 影響範囲

- `src/message/setup.ts`
- `src/message/parameter.ts`
- `src/session.ts`

## 実装方針

1. コードベース全体で "Setup Parameters" / "setupParameters" への参照を検索する
2. 型名、変数名、コメントを Setup Options に変更する
3. テストを更新する

## 解決方法

`SetupParameterType` を `SetupOptionType` にリネームした。変更ファイル:

- `src/message/types.ts`: 型定義とコメントのリネーム
- `src/message/setup.ts`: 参照のリネーム
- `src/message/setup.test.ts`: テスト内の参照のリネーム
- `src/message/index.ts`: エクスポートのリネーム
