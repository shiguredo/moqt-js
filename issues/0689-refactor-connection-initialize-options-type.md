# connectionInitialize の引数型が ConnectionInitializeOptions と重複している

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-connection-initialize-options-type
- Polished: 2026-09-24

## 目的

`src/session/connection.ts` は `ConnectionInitializeOptions` を定義しているのに、`connectionInitialize` の引数で同じ 9 フィールドの inline 型を再宣言している。構造的部分型のため型エラーにはならず、片方だけフィールドを足すと値が黙って捨てられる。実際に closed の `0646-bug-data-stream-buffer-limit.md` が `dataStreamMaxBufferBytes` を追加したときは両方へ足す必要があり、JSDoc も片方にしか無い差分が生まれている。同種の inline 型が `connectionApplyTimeoutOptions` と `connectionResolveLocalMaxRequestUpdates` にもあり、SETUP のオプションを増やすたびに同じ追加工事が発生する。0646 の「残した課題」にもこの重複が記録されている。

## 現状

- `src/session/connection.ts` の `ConnectionInitializeOptions` (56-93 行目) が `authorizationToken` / `moqtImplementation` / `grease` / `maxAuthTokenCacheSize` / `maxRequestUpdates` / `maxFilterRanges` / `controlMessageTimeoutMs` / `dataStreamTimeoutMs` / `dataStreamMaxBufferBytes` の 9 フィールドを定義する
- 同ファイルの `connectionInitialize` (193-232 行目) は同じ 9 フィールドを inline 型で再宣言している (195-231 行目)。JSDoc も複製されており、`dataStreamMaxBufferBytes` の「詳細は ConnectOptions.dataStreamMaxBufferBytes を参照。」が `ConnectionInitializeOptions` 側 (90 行目) にだけあり、inline 型側 (224-230 行目) には無い
- `connectionApplyTimeoutOptions` (595-610 行目) は 3 フィールドの inline 型 (597-601 行目) を、`connectionResolveLocalMaxRequestUpdates` (188-192 行目) は 1 フィールドの inline 型 (188-190 行目) を別に持つ
- 呼び出しは `SessionImpl.initialize(options?: ConnectionInitializeOptions)` (`src/session.ts` 661-663 行目) から `connectionInitialize(this as unknown as ConnectionSessionInternal, options)` の形である。`options` は `ConnectionInitializeOptions` 型の値として inline 型の引数へ渡るため、両者は構造的に一致していなければならない
- `tsconfig.json` は `exactOptionalPropertyTypes: true` を有効にしている。両方の型が `?: number` と書いているため現状は互換だが、片方だけ `| undefined` を許す形にすると `initialize` からの呼び出しが型エラーになる
- `ConnectionInitializeOptions` は `src/index.ts` から export されていない。公開の `Session` インターフェース (`src/session.ts` 151 行目) に `initialize` は無く、`SessionImpl.initialize` は内部メソッドである。したがって型を 1 つに寄せても公開 API は変わらない
- 0646 の「残した課題」に「`initialize` のインライン型の重複 (ConnectionInitializeOptions) は差分外の既存事項」と記録されている

## 設計方針

- `connectionInitialize(session, options?: ConnectionInitializeOptions)` に変え、inline 型 (195-231 行目) を削除する
- `connectionApplyTimeoutOptions` の引数型を `Pick<ConnectionInitializeOptions, "controlMessageTimeoutMs" | "dataStreamTimeoutMs" | "dataStreamMaxBufferBytes">` にする。`Pick` にすることで「どのフィールドを反映するか」が型に残り、`ConnectionInitializeOptions` にフィールドが増えても黙って拾わない (反映漏れに気づける)
- `connectionResolveLocalMaxRequestUpdates` の引数型を `Pick<ConnectionInitializeOptions, "maxRequestUpdates">` にする
- `ConnectionSessionInternal` のフィールド宣言 (120-124 行目) は実行時のビューであり別の型なので変えない
- JSDoc は `ConnectionInitializeOptions` の 1 か所へ寄せ、`connectionInitialize` にはフィールド一覧を書かない。0646 で生じた JSDoc の差分 (90 行目と 224-230 行目) が解消される
- `ConnectionInitializeOptions` を公開面へ追加しない。`initialize` は公開の `Session` インターフェースに無く、`src/index.ts` は `SessionImpl` も export していないため、参照できるのはパッケージ内部だけである。この判断を型の JSDoc に書く
- 型のみの変更であり実行時の挙動は変わらない。テストは既存の `initialize()` のオプション反映テスト (`src/session.test.ts` の 8200 行目付近と 6283 行目以降) をそのまま使い、配線が守られていることを確認する
- `CHANGES.md` には追記しない (利用者から見た挙動の変更が無い)

## 完了条件

- `connectionInitialize` の引数型が `ConnectionInitializeOptions` である
- `connectionApplyTimeoutOptions` / `connectionResolveLocalMaxRequestUpdates` の引数型が `ConnectionInitializeOptions` の `Pick` である
- `src/session/connection.ts` に 9 フィールドを並べた inline 型が残っていない
- `ConnectionInitializeOptions.dataStreamMaxBufferBytes` の JSDoc 差分が解消され、フィールドの説明が 1 か所だけにある
- `src/index.ts` の公開面が変わらない
- `initialize` のオプション反映テスト (SETUP 広告 / 受信タイムアウト / 受信バッファ上限) がそのまま通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.1 (SETUP) / §12.2 (CONTROL_MESSAGE_TIMEOUT 0x11 / DATA_STREAM_TIMEOUT 0x12) / §12.5 (EXCESSIVE_LOAD 0x9)。`initialize` のオプションが対応する節である
- closed `0646-bug-data-stream-buffer-limit.md` (型を 2 箇所へ足す必要があった例。残した課題に重複が記録されている)

## 解決方法

{未着手}
