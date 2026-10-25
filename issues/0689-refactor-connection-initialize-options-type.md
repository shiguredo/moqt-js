# connectionInitialize の引数型が ConnectionInitializeOptions と重複している

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-connection-initialize-options-type
- Polished: 2026-10-26

## 目的

`src/session/connection.ts` は `ConnectionInitializeOptions` を定義しているのに、`connectionInitialize` の引数で同じフィールドの inline 型を再宣言している。構造的部分型のため型エラーにはならず、片方だけフィールドを足すと値が黙って捨てられる。実際に closed の `0646-bug-data-stream-buffer-limit.md` が `dataStreamMaxBufferBytes` を追加したときは両方へ足す必要があり、closed の `0686-bug-session-wide-data-stream-buffer-cap.md` が `dataStreamMaxTotalBufferBytes` を追加したときも同じ追加工事が発生している。JSDoc も片方にしか無い差分が生まれている。同種の inline 型が `connectionApplyTimeoutOptions` と `connectionResolveLocalMaxRequestUpdates` にもあり、フィールドを追加するたびに `ConnectionInitializeOptions` と inline 型の両方を見直す必要がある。0646 の「残した課題」にもこの重複が記録されている。

## 現状

- `src/session/connection.ts` の `ConnectionInitializeOptions` は `authorizationToken` / `moqtImplementation` / `grease` / `maxAuthTokenCacheSize` / `maxRequestUpdates` / `maxFilterRanges` / `controlMessageTimeoutMs` / `dataStreamTimeoutMs` / `dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes` の 10 フィールドを定義する
- 同ファイルの `connectionInitialize` は同じ 10 フィールドを inline 型で再宣言している。JSDoc も複製されており、`dataStreamMaxBufferBytes` の「詳細は ConnectOptions.dataStreamMaxBufferBytes を参照。」と `dataStreamMaxTotalBufferBytes` の「詳細は ConnectOptions.dataStreamMaxTotalBufferBytes を参照。」が `ConnectionInitializeOptions` 側にだけあり、inline 型側には無い
- `connectionApplyTimeoutOptions` は `controlMessageTimeoutMs` / `dataStreamTimeoutMs` / `dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes` の 4 フィールドの inline 型を、`connectionResolveLocalMaxRequestUpdates` は `maxRequestUpdates` の 1 フィールドの inline 型を別に持つ
- 呼び出しは `SessionImpl.initialize(options?: ConnectionInitializeOptions)` (`src/session.ts`) から `connectionInitialize(this as unknown as ConnectionSessionInternal, options)` の形である。`options` は `ConnectionInitializeOptions` 型の値として inline 型の引数へ渡るため、両者は構造的に互換でなければならない
- `tsconfig.json` は `exactOptionalPropertyTypes: true` を有効にしている。両方の型が `?: number` と書いているため現状は互換だが、片方だけ `| undefined` を許す形にすると `initialize` からの呼び出しが型エラーになる
- `ConnectionInitializeOptions` は `src/index.ts` から export されていない。公開の `Session` インターフェース (`src/session.ts`) に `initialize` は無く、`SessionImpl.initialize` は公開の `Session` インターフェースには含まれない。`src/index.ts` は `SessionImpl` も export していない。したがって型を 1 つに寄せても公開 API は変わらない
- `ConnectionSessionInternal` は `SessionImpl` を `as unknown as` で渡すための実行時ビューであり、`ConnectionInitializeOptions` とは別の型である
- 0646 の「残した課題」に「`dataStreamTimeoutMs` の `connect()` 配線と `initialize` のインライン型の重複 (ConnectionInitializeOptions) は差分外の既存事項」と記録されている

## 設計方針

- `connectionInitialize(session, options?: ConnectionInitializeOptions)` に変え、inline 型を削除する
- `connectionApplyTimeoutOptions` の引数型を `Pick<ConnectionInitializeOptions, "controlMessageTimeoutMs" | "dataStreamTimeoutMs" | "dataStreamMaxBufferBytes" | "dataStreamMaxTotalBufferBytes">` にする。`Pick` にすることで「どのフィールドを反映するか」が型に残り、`ConnectionInitializeOptions` にフィールドが増えたときに、この関数へ反映するかどうかを Pick の一覧で判断できる。`Pick` に含めないフィールドは関数内で読まない
- `connectionResolveLocalMaxRequestUpdates` の引数型を `Pick<ConnectionInitializeOptions, "maxRequestUpdates">` にする
- `ConnectionSessionInternal` のフィールド宣言は実行時のビューであり別の型なので変えない
- `ConnectionInitializeOptions` のフィールドは変えない (inline 型の削除だけを行う)
- JSDoc は `ConnectionInitializeOptions` の 1 か所へ寄せ、`connectionInitialize` にはフィールド一覧を書かない。0646 と 0686 で生じた JSDoc の差分が解消される
- `ConnectionInitializeOptions` を公開面へ追加しない。`initialize` は公開の `Session` インターフェースに無く、`src/index.ts` は `SessionImpl` も export していないため、参照できるのはパッケージ内部だけである。この判断を型の JSDoc に書く
- 変更対象は `src/session/connection.ts` のみである。`src/session.ts` の `SessionImpl.initialize` は既に `ConnectionInitializeOptions` を受け取るため変更しない
- 型のみの変更であり実行時の挙動は変わらない。テストは既存の `initialize` のオプション反映テスト (`src/session.test.ts` の「initialize: SETUP で上限を広告し localMaxFilterRanges と受信バッファ上限を保持する」) をそのまま使い、SETUP 広告と受信バッファ上限の配線が守られていることを確認する。受信タイムアウトはこのテストでは直接固定されていないが、`connectionApplyTimeoutOptions` の型を変えるだけで実行時の代入は変わらない
- `CHANGES.md` には追記しない (利用者から見た挙動の変更が無い。CODEBASE.md の MOQT RFC ドラフト中の特別ルールにも従う)

## 完了条件

- `connectionInitialize` の引数型が `ConnectionInitializeOptions` である
- `connectionApplyTimeoutOptions` の引数型が `Pick<ConnectionInitializeOptions, "controlMessageTimeoutMs" | "dataStreamTimeoutMs" | "dataStreamMaxBufferBytes" | "dataStreamMaxTotalBufferBytes">` であり、`connectionResolveLocalMaxRequestUpdates` の引数型が `Pick<ConnectionInitializeOptions, "maxRequestUpdates">` である
- `src/session/connection.ts` に `ConnectionInitializeOptions` のフィールドを並べた inline 型が残っていない
- `ConnectionInitializeOptions.dataStreamMaxBufferBytes` と `dataStreamMaxTotalBufferBytes` の JSDoc 差分が解消され、フィールドの説明が 1 か所だけにある
- `ConnectionInitializeOptions` の JSDoc に、公開 API ではないこと (`src/index.ts` から export しないこと) が書かれている
- `ConnectionInitializeOptions` のフィールドが増減しない
- `connectionApplyTimeoutOptions` の `session` への代入 (4 フィールド) が変わらない
- `src/session.ts` の `SessionImpl.initialize` のシグネチャが変わらない
- `src/index.ts` の公開面が変わらない
- 既存の `initialize` のオプション反映テスト (`src/session.test.ts` の「initialize: SETUP で上限を広告し localMaxFilterRanges と受信バッファ上限を保持する」) がそのまま通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-22 §9.1 (SETUP) / §12.2 (CONTROL_MESSAGE_TIMEOUT 0x11 / DATA_STREAM_TIMEOUT 0x12) / §12.5 (EXCESSIVE_LOAD 0x9)。`initialize` のオプションが対応する節である
- closed `0646-bug-data-stream-buffer-limit.md` (型を 2 箇所へ足す必要があった例。残した課題に重複が記録されている)
- closed `0686-bug-session-wide-data-stream-buffer-cap.md` (`dataStreamMaxTotalBufferBytes` を追加したときも同じ追加工事が発生した例)

## 解決方法

{未着手}
