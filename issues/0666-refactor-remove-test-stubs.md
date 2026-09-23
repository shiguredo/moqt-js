# テスト用の手書きスタブを実ストリームに置き換える

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-remove-test-stubs
- Polished: {YYYY-MM-DD}

## 目的

`src/testSupport/bidi.ts` の `createBidiSession` は `WritableStreamDefaultWriter` の手書きスタブと空の stream オブジェクトを型キャストで渡している。AGENTS.md はモック・スタブの利用を禁じており、スタブは実装が呼ぶ API の欠落を検出できない。同じファイルのコメント自身が、実物を渡さない依存について「TypeError が握り潰されてテストが通ってしまう」危険を認めている。

## 現状

- `createBidiSession` は `{ write: async (data) => { written.push(data); } } as unknown as WritableStreamDefaultWriter<Uint8Array>` を組み立て、`requestStreams` には `stream: {}` を入れる。session 自体も `BidiSessionInternal` へのオブジェクトリテラルのキャストである
- 同ファイルのコメントは、実物を渡さない依存 (`pendingSubgroupBuffer`) について「実物を渡さないと TypeError になり、`defaultBidiHandleError` に握り潰されて pending の解決と読み取りループ起動に到達しないままテストが通ってしまう」と明記している。writer と stream には同じ危険が残っている
- `createBidiSession` は 6 つのテストファイル (`src/session/bidi.prop.ts` を含む) から使われている
- 同ファイルの `createPublishReadTestContext` / `createResponseReadTestContext` は実 `ReadableStream` / `WritableStream` で組んでおり、ストリーム機構は実物である。置き換え先の形はここに揃えられる
- スタブが隠している不具合の有無は未調査である

## 設計方針

- 実 `ReadableStream` / `WritableStream` と実 `SessionImpl` を使う形に置き換える
- テストが観測する書き込みバイト列 (`written`) は実 `WritableStream` の sink で収集し、スタブを介さずに得る
- 置き換えで露見する実装の不具合は本 issue では直さない。再現条件と症状を報告に残し、別 issue として起票する

## 完了条件

- `createBidiSession` からスタブが消え、対象テストが実装を使って通る
- 露見した不具合が再現条件つきで報告されている
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0667 (テストヘルパーと PBT arbitrary の集約。対象は `src/message/*.prop.ts` で本 issue とは別)

## 解決方法

{未着手}
