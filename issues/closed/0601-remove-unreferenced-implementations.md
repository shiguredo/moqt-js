# リポジトリ全体から参照されていない実装コードを削除する

- Created: 2026-09-13
- Completed: 2026-09-13
- Branch: feature/remove-unreferenced-implementations
- Polished: {YYYY-MM-DD}

## 目的

実装コードの中に、リポジトリ全体 (`src/` / `devtools/` / `examples/` / `tests/`) から参照されていない export と、書き込み専用になったフィールドが残っている。読み手に「使われている機能」と誤解させ、変更時の影響範囲調査を無駄に広げる。参照が無いことを確認したものを削除して保守対象を減らす。

## 現状

削除対象は次の 9 箇所。いずれも `rg` でリポジトリ全体を検索し、定義以外に出現しない (またはテストファイルのみに出現する) ことを確認済み。

### 未参照のファイル

- `src/codec/index.ts` — `export type * from "./types"` / `export * from "./config"` / 4 つの Wrapper の再 export を持つバレルだが、リポジトリ全体でこのパスを import する箇所が 0 件。利用側は `./codec/AudioDecoder` のように個別パスを直接指定している。`src/index.ts` は `./codec/types` を直接参照しており `./codec` を経由しないため、公開 API にも影響しない。

### テストファイルからしか参照されていない API

- `src/controlStream.ts` の `ControlStreamWriter.encodeMessage` — 参照は `src/controlStream.test.ts` の 3 箇所のみ。
- `src/controlStream.ts` の `ControlStreamReader.bufferSize` — 参照は `src/controlStream.test.ts` の 7 箇所のみ。
- `src/controlStream.ts` の `ControlStreamReader.isFinReceived` — 参照は `src/controlStream.test.ts` の 2 箇所のみ。
- `src/codec/VideoDecoder.ts` の `state` getter / `src/codec/AudioDecoder.ts` の `state` getter — 読み出しは 0 件。テストでも読まれていない (利用側は `videoDecoderConfigured` / `audioDecoderConfigured` フラグで判定している)。**Decoder の 2 つだけが対象**であり、`src/codec/VideoEncoder.ts` / `src/codec/AudioEncoder.ts` の `state` getter は `src/createMediaPublisher.ts` の `processVideoFrames` / `processAudioFrames` が `encoder.state === "configured"` として読むため**削除してはならない**。
- `src/codec/AudioEncoder.ts` の `encodeQueueSize` getter — 定義が 1 件あるだけで読み出しは 0 件。同じ getter が `src/codec/VideoEncoder.ts` にあり、そちらは `src/createMediaPublisher.ts` から実際に読まれている。
- `src/codec/AudioDecoder.ts` の `reset()` と `lastConfig` — `reset()` の呼び出しは `src/createMediaSubscriber.ts` の `this.videoDecoder?.reset()` の 1 箇所のみで、音声側の呼び出しは 0 件。`lastConfig` は `reset()` からしか参照されていない。

### 削除対象から外したもの (誤って含めないこと)

- `src/publisher.ts` の `PublisherState` / `src/subscriber.ts` の `SubscriberState` / `src/fetcher.ts` の `FetcherState` は、定義ファイル内でしか出現しないが、**公開インターフェースの一部**である。`src/publisher.ts` の `Publisher` インターフェースが `readonly state: PublisherState` を持ち、同じ型が `src/index.ts` から `export type { Publisher, ... }` として公開されている (`Subscriber` / `Fetcher` も同様)。型を消すと公開 API が壊れるため、対象外とする。

### 書き込み専用のフィールド

- `src/pendingSubgroupBuffer.ts` の `PendingSubgroupEntry.header` — コンストラクタの `readonly header: SubgroupHeader` は代入されるだけで、読み出しは 0 件。削除すると `SubgroupHeader` の import も不要になる。
- `src/msf.ts` の `ValidationContext.catalogNamespace` — 型の宣言だけがあり、`validateCatalogTrack` が読むのは `ctx.source` のみ。同じファイル内の `normalizeNamespace(cloneTrack.parentNamespace, catalogNamespace)` などで使われる `catalogNamespace` は別の局所変数であり、`ValidationContext` とは無関係。なお同フィールドの JSDoc は「正規化に使用する」と書かれており実装と乖離しているため、フィールド削除とあわせて記述を見直す。
- `src/msf.ts` の `ValidationContext.source` の `"remove"` — `source: "remove"` で `validateCatalogTrack` を呼ぶ箇所が 0 件 (remove 操作は `validateRemoveTrack` 経由で検証される)。union から削除する。

## 設計方針

1. 挙動を変えない。削除するのは参照が無いものだけで、ロジックの変更や API の仕様変更は行わない。
2. 削除の前に、対象ごとに「定義以外に出現しない」ことを `rg` で再確認する。特に `src/codec/index.ts` は削除後に `src/index.ts` からの型参照が壊れないことを `tsc --noEmit` で確かめる。
3. `src/codec/AudioEncoder.ts` の `encodeQueueSize` は、削除すると音声側のキュー長を監視する手段が無くなる。`src/createMediaPublisher.ts` の video 側監視 (閾値 2 でキーフレーム要求) に相当する処理を音声に足すかは本 issue の対象外とし、未使用の getter を削除するだけにする。
4. 今回の対象外は次のとおり。混在させない。
   - `src/msf.ts` の `KNOWN_CIPHER_SUITES` は、参照が 0 件であることは確認できたが、どの cipher suite を受け入れるかの判断材料として保持する意図がありうるため、対象から外す。
   - `src/msf.ts` / `src/properties.ts` / `src/dataStream.ts` / `src/session/params.ts` の「テストからしか参照されない純粋関数」(msf の Variable Substitution と range ヘルパ、`parseProperties` / `decodeImmutableProperties` / `encodeImmutableProperties` など) は、実装が数十〜数百行あり、削除すると仕様カバレッジと将来の配線可能性の判断を伴う。`issues/0503-refactor-msf-split.md` などと重なるため対象外とする。
   - `src/fetcher.ts` の `setFetchOkInfo` の第 4 引数 `groupOrder` は、渡されていないことを確認したが、「将来のためフィールドは残す」と明示コメントされた設計判断であり、削除ではなく仕様判断が必要なため対象外とする。
   - `src/session.ts` の純粋委譲メソッド群、`src/codec` の 4 Wrapper の重複、`src/message/trackstatus.ts` と `src/message/subscribe.ts` の重複は規模が大きく別 issue の領域とする。

## 完了条件

- 上記 9 箇所が削除され、リポジトリ全体で参照が残っていないこと。
- `src/codec/index.ts` の削除後も `src/index.ts` の型 export が成立すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` の `### misc` に `[CHANGE]` を追加すること (未使用コードの削除のため)。

## 参照

- `src/codec/index.ts` / `src/codec/AudioDecoder.ts` / `src/codec/AudioEncoder.ts` / `src/codec/VideoDecoder.ts` / `src/codec/VideoEncoder.ts`
- `src/controlStream.ts` / `src/controlStream.test.ts`
- `src/publisher.ts` / `src/subscriber.ts` / `src/fetcher.ts`
- `src/pendingSubgroupBuffer.ts`
- `src/msf.ts` (`ValidationContext` / `validateCatalogTrack`)
- `issues/0589-remove-unused-track-accessors.md` (同じく未使用コードの削除。対象は `SubscriberImpl` / `FetcherImpl` / `PublisherImpl` のアクセサで本 issue とは重複しない)

## 解決方法

起票時に挙げた 9 箇所を削除した。実装前の再検証で対象の誤りを 2 件見つけて修正したうえで着手している。

### 実装前の再検証で修正した点

- `VideoEncoderWrapper.state` / `AudioEncoderWrapper.state` は未使用ではなかった。`src/createMediaPublisher.ts` の `processVideoFrames` / `processAudioFrames` が `encoder.state === "configured"` として読む。削除対象を Decoder の 2 つに限定した。
- `PublisherState` / `SubscriberState` / `FetcherState` は死にコードではなかった。`Publisher` / `Subscriber` / `Fetcher` インターフェースが `readonly state: <型>` を持ち、そのインターフェースは `src/index.ts` から公開されている。削除対象から外した。

### 削除したもの

- `src/codec/index.ts` をファイルごと削除した。このパスを import する箇所はリポジトリ全体で 0 件で、`src/index.ts` は `./codec/types` を直接参照している。
- `src/controlStream.ts` から `ControlStreamWriter.encodeMessage` / `ControlStreamReader.bufferSize` / `ControlStreamReader.isFinReceived` を削除した。あわせて `finReceived` フィールドと `feed()` の `fin` 引数も削除した (`fin` は `finReceived` を設定するためだけにあり、その値を読む経路が無いため)。
- `src/codec/VideoDecoder.ts` と `src/codec/AudioDecoder.ts` から `state` getter を削除した。
- `src/codec/AudioEncoder.ts` から `encodeQueueSize` getter を削除した。
- `src/codec/AudioDecoder.ts` から `reset()` と、その再構成用にのみ保持していた `lastConfig` フィールドと `configure()` での代入を削除した (音声側の `reset()` 呼び出しは 0 件)。
- `src/pendingSubgroupBuffer.ts` から `PendingSubgroupEntry.header` と `PendingSubgroupBuffer.add()` の `header` 引数、不要になった `SubgroupHeader` の import を削除した。`src/session.ts` の呼び出しも追随させた。
- `src/msf.ts` の `ValidationContext` から `catalogNamespace` を削除し、`source` の union から到達しない `"remove"` を削除した。あわせて `catalogNamespace` の実装と乖離した JSDoc を、`remove` operation は `validateRemoveTrack` で検証する旨の記述に置き換えた。

### 追随して修正したテスト

- `src/controlStream.test.ts`: `bufferSize` / `isFinReceived` / `encodeMessage` を使っていたテストを、`encode()` と `feed()` の戻り値で検証する形に書き換えた。`bufferSize` の数値検証は「メッセージが揃うまで取り出せない」という挙動検証に置き換え、`encodeMessage` の roundtrip は `encode(m.type, m.payload)` に変更した。
- `src/pendingSubgroupBuffer.test.ts`: `add()` の呼び出し 17 箇所から `header` 引数を外し、不要になった `makeHeader` ヘルパーと `SubgroupHeader` の import を削除した。

### 検証

- `pnpm test run`: 70 ファイル / 2,090 テスト全通過 (着手前 2,093。削除した API 専用のテスト 3 件分が減り、既存の検証内容は維持している)
- `pnpm typecheck` / `pnpm lint` / `pnpm fmt` すべて成功
- 削除後の差分は 11 ファイル、+39 / -177 行
