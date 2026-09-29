# テスト用の手書きスタブを実ストリームに置き換える

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-remove-test-stubs
- Polished: 2026-09-29

## 目的

`src/testSupport/bidi.ts` の `createBidiSession` は `WritableStreamDefaultWriter` の手書きスタブと空の stream オブジェクトを型キャストで渡している。AGENTS.md はモック・スタブの利用を禁じており、スタブは実装が呼ぶ API の欠落を検出できない。同じファイルのコメント自身が、実物を渡さない依存について「TypeError が握り潰されてテストが通ってしまう」危険を認めている。

## 現状

- `createBidiSession` は `{ write: async (data) => { written.push(data); } } as unknown as WritableStreamDefaultWriter<Uint8Array>` を組み立て、`requestStreams` には `stream: {}` を入れる。session 自体も `BidiSessionInternal` へのオブジェクトリテラルのキャストである
- 同ファイルのコメントは、実物を渡さない依存 (`pendingSubgroupBuffer`) について「実物を渡さないと TypeError になり、`defaultBidiHandleError` に握り潰されて pending の解決と読み取りループ起動に到達しないままテストが通ってしまう」と明記している。writer と stream には同じ危険が残っている
- `createBidiSession` は 6 つのテストファイル (`src/session/bidi.prop.ts` を含む) から使われている
- 同ファイルの `createPublishReadTestContext` / `createOkResponseReadTestContext` は実 `ReadableStream` / `WritableStream` で組んでおり、ストリーム機構は実物である。ただし session はどちらもオブジェクトリテラルの型キャストであり、実 `SessionImpl` ではない。実 `SessionImpl` への置き換えは本 issue の `createBidiSession` のみが対象で、ストリーム機構の置き換え先の形だけをここに揃える
- スタブが隠している不具合の有無は未調査である

## 設計方針

- 実 `ReadableStream` / `WritableStream` と実 `SessionImpl` を使う形に置き換える
- テストが観測する書き込みバイト列 (`written`) は実 `WritableStream` の sink で収集し、スタブを介さずに得る
- 実 `SessionImpl` は初期値が `createBidiSession` と異なるため、既存テストが依存する設定値を維持する。具体には requestId 0n の `requestStreams` エントリ、`nextRequestId: 100n`、`peerMaxFilterRanges: 2` である (実 `SessionImpl` は `peerMaxFilterRanges: 0` で初期化される)。`bidiSendRequestUpdateFill.test.ts` と `bidiResponseScopeViolation.test.ts` は `peerMaxFilterRanges: 2` と上限超過メッセージ (…MAX_FILTER_RANGES 2…) に依存しており、設定は既存テストがフィールドを上書きしている形 (例えば `bidiSendRequestUpdateFill.test.ts` の `peerMaxFilterRanges = 3` / `= 0`) と同じやり方で揃える
- 置き換えで露見する実装の不具合は本 issue では直さない。再現条件と症状を別 issue として起票する (起票後も本 issue からは直さない)

## 完了条件

- `createBidiSession` からスタブが消え、使用している 6 つのテストファイル (src/session/bidi.prop.ts を含む) が実装を使って通る
- 露見した不具合が再現条件つきで別 issue として起票されている
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0667 (テストヘルパーと PBT arbitrary の集約。対象は `src/message/*.prop.ts` で本 issue とは別)

## 解決方法

{未着手}
